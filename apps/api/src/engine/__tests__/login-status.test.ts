import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mockSpawn = vi.hoisted(() => vi.fn())

vi.mock('../cli-spawn.js', () => ({ spawnCli: mockSpawn }))

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
  spawn: mockSpawn,
}))

import { ClaudeCodeEngine } from '../claude-code.js'
import { CodexAgentEngine } from '../codex-agent.js'
import { CursorAgentEngine } from '../cursor-agent.js'
import { runStatusProbe } from '../login-status-helper.js'

class MockChildProcess extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  pid = 99999
  kill = vi.fn()
}

/**
 * Hands out one child per spawn call, in order.
 *
 * Codex probes twice — `login status` for "are there credentials" and `doctor`
 * for "are they still accepted" — so a single shared child would leave the
 * second probe listening to an emitter that already closed.
 */
function queueChildren(count: number): MockChildProcess[] {
  const children = Array.from({ length: count }, () => new MockChildProcess())
  let next = 0
  mockSpawn.mockImplementation(() => children[Math.min(next++, children.length - 1)])
  return children
}

/** 便捷：一次性给子进程喂 stdout，然后 close(exitCode) */
function settle(child: MockChildProcess, stdout: string, exitCode = 0) {
  child.stdout.write(stdout)
  child.stdout.end()
  child.emit('close', exitCode)
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('CodexAgentEngine.checkLoginStatus', () => {
  const engine = new CodexAgentEngine({
    path: 'codex',
    apiKey: '',
    timeoutMinutes: 5,
    force: false,
    approveMcps: true,
    defaultWorkDir: '/tmp',
  })

  it('logged in via ChatGPT', async () => {
    const [statusChild, doctorChild] = queueChildren(2)
    const promise = engine.checkLoginStatus()
    settle(statusChild, 'Logged in using ChatGPT\n', 0)
    await Promise.resolve()
    settle(doctorChild, '   ✓ auth         credentials accepted\n', 0)
    const status = await promise
    expect(status.installed).toBe(true)
    expect(status.loggedIn).toBe(true)
    expect(status.method).toBe('ChatGPT')
    expect(status.detail).toContain('Logged in')
  })

  it('not logged in (exit non-zero)', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const promise = engine.checkLoginStatus()
    settle(child, 'Not logged in\n', 1)
    const status = await promise
    expect(status.installed).toBe(true)
    expect(status.loggedIn).toBe(false)
    expect(status.error).toBeTruthy()
  })

  it('CLI not installed (spawn ENOENT)', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const promise = engine.checkLoginStatus()
    const err = new Error('not found') as NodeJS.ErrnoException
    err.code = 'ENOENT'
    child.emit('error', err)
    const status = await promise
    expect(status.installed).toBe(false)
    expect(status.loggedIn).toBe(false)
    expect(status.error).toMatch(/not found/i)
  })

  it('handles leading/trailing whitespace + exit 0', async () => {
    const [statusChild, doctorChild] = queueChildren(2)
    const promise = engine.checkLoginStatus()
    settle(statusChild, '\n\n  Logged in using ChatGPT  \n\n', 0)
    await Promise.resolve()
    settle(doctorChild, '   ✓ auth         credentials accepted\n', 0)
    const status = await promise
    expect(status.loggedIn).toBe(true)
    expect(status.method).toBe('ChatGPT')
  })

  it('falls back to stderr when stdout is empty', async () => {
    const [statusChild, doctorChild] = queueChildren(2)
    const promise = engine.checkLoginStatus()
    statusChild.stderr.write('Logged in using ChatGPT\n')
    statusChild.stderr.end()
    statusChild.stdout.end()
    statusChild.emit('close', 0)
    await Promise.resolve()
    settle(doctorChild, '   ✓ auth         credentials accepted\n', 0)
    const status = await promise
    expect(status.loggedIn).toBe(true)
  })

  /**
   * `codex login status` only reports whether a credential FILE exists. A
   * revoked refresh token still reads "Logged in using ChatGPT" there, and
   * every run then dies on a 401 — which is exactly how a deployment ends up
   * with a green config page and a Runs list that is entirely failures. Only
   * `codex doctor` asks OpenAI.
   */
  it('reports a revoked credential as invalid, not as logged in', async () => {
    const [statusChild, doctorChild] = queueChildren(2)
    const promise = engine.checkLoginStatus()
    settle(statusChild, 'Logged in using ChatGPT\n', 0)
    await Promise.resolve()
    settle(
      doctorChild,
      'Notes\n   ✗ auth         no Codex credentials were found - Run codex login\n',
      1,
    )
    const status = await promise
    expect(status.installed).toBe(true)
    expect(status.loggedIn).toBe(false)
    expect(status.verified).toBe(true)
    expect(status.code).toBe('CREDENTIALS_REJECTED')
    expect(status.error).toMatch(/no Codex credentials were found/)
  })

  it('marks a confirmed session as verified', async () => {
    const [statusChild, doctorChild] = queueChildren(2)
    const promise = engine.checkLoginStatus()
    settle(statusChild, 'Logged in using ChatGPT\n', 0)
    await Promise.resolve()
    settle(doctorChild, 'Notes\n   ✓ auth         signed in as someone\n', 0)
    const status = await promise
    expect(status.loggedIn).toBe(true)
    expect(status.verified).toBe(true)
  })

  it('keeps the local verdict when the verifier itself cannot answer', async () => {
    // A doctor run that never completes says nothing about the credential, so
    // downgrading to "not logged in" would invent an outage. The verdict stays
    // local and is reported as unverified.
    const [statusChild, doctorChild] = queueChildren(2)
    const promise = engine.checkLoginStatus()
    settle(statusChild, 'Logged in using ChatGPT\n', 0)
    await Promise.resolve()
    const err = new Error('not found') as NodeJS.ErrnoException
    err.code = 'ENOENT'
    doctorChild.emit('error', err)
    const status = await promise
    expect(status.loggedIn).toBe(true)
    expect(status.verified).toBe(false)
  })

  it('keeps the local verdict on a codex too old to know the doctor subcommand', async () => {
    // codex declares no minVersion floor, so a deployment may run a build
    // without `doctor`. Its "unrecognized subcommand" reply must degrade to the
    // pre-verification behaviour rather than report the session as gone.
    const [statusChild, doctorChild] = queueChildren(2)
    const promise = engine.checkLoginStatus()
    settle(statusChild, 'Logged in using ChatGPT\n', 0)
    await Promise.resolve()
    doctorChild.stderr.write("error: unrecognized subcommand 'doctor'\n")
    doctorChild.stderr.end()
    doctorChild.stdout.end()
    doctorChild.emit('close', 2)
    const status = await promise
    expect(status.loggedIn).toBe(true)
    expect(status.verified).toBe(false)
    expect(status.code).toBeUndefined()
  })

  it('does not spend a verification probe when there is no credential at all', async () => {
    const [statusChild] = queueChildren(1)
    const promise = engine.checkLoginStatus()
    settle(statusChild, 'Not logged in\n', 1)
    const status = await promise
    expect(status.loggedIn).toBe(false)
    expect(status.verified).toBeUndefined()
    expect(mockSpawn).toHaveBeenCalledTimes(1)
  })

  it('explicit "Please run codex login" is treated as not logged in even with exit 0', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const promise = engine.checkLoginStatus()
    settle(child, 'Not logged in. Please run `codex login`.\n', 0)
    const status = await promise
    expect(status.loggedIn).toBe(false)
    expect(status.error).toMatch(/not logged in/i)
  })
})

describe('ClaudeCodeEngine.checkLoginStatus', () => {
  const engine = new ClaudeCodeEngine({
    path: 'claude',
    apiKey: '',
    baseUrl: '',
    timeoutMinutes: 5,
    force: false,
    approveMcps: true,
    defaultWorkDir: '/tmp',
  })

  it('parses claude auth status --json output when logged in', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const promise = engine.checkLoginStatus()
    settle(
      child,
      JSON.stringify({
        loggedIn: true,
        authMethod: 'claude.ai',
        email: 'alice@example.com',
        subscriptionType: 'max',
      }),
      0,
    )
    const status = await promise
    expect(status.installed).toBe(true)
    expect(status.loggedIn).toBe(true)
    expect(status.method).toBe('claude.ai')
    expect(status.detail).toContain('alice@example.com')
    expect(status.detail).toContain('max')
  })

  it('reports not logged in when JSON says so', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const promise = engine.checkLoginStatus()
    settle(child, JSON.stringify({ loggedIn: false }), 0)
    const status = await promise
    expect(status.loggedIn).toBe(false)
    expect(status.error).toBeTruthy()
  })
})

describe('CursorAgentEngine.checkLoginStatus (cursor-agent about)', () => {
  const engine = new CursorAgentEngine({
    apiKey: '',
    timeoutMinutes: 5,
    agentForce: false,
    approveMcps: false,
    defaultWorkDir: '/tmp',
  })

  const ABOUT_LOGGED_IN = `About Cursor CLI

CLI Version         2026.03.30-a5d3e17
Model               Composer 1.5
OS                  darwin (arm64)
Terminal            iterm2
Shell               zsh
User Email          alice@example.com
`

  const ABOUT_NOT_LOGGED_IN = `About Cursor CLI

CLI Version         2026.03.30-a5d3e17
Model               Composer 1.5
OS                  darwin (arm64)
Terminal            iterm2
Shell               zsh
User Email          Not logged in
`

  it('parses `User Email <email>` as logged in', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const promise = engine.checkLoginStatus()
    settle(child, ABOUT_LOGGED_IN, 0)
    const status = await promise
    expect(status.installed).toBe(true)
    expect(status.loggedIn).toBe(true)
    expect(status.method).toBe('alice@example.com')
    expect(status.detail).toContain('alice@example.com')
  })

  it('parses `User Email Not logged in` as not logged in', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const promise = engine.checkLoginStatus()
    settle(child, ABOUT_NOT_LOGGED_IN, 0)
    const status = await promise
    expect(status.installed).toBe(true)
    expect(status.loggedIn).toBe(false)
    expect(status.error).toMatch(/not logged in/i)
  })
})

describe('runStatusProbe completeEnv', () => {
  it('resolves a synchronous Windows spawn failure instead of rejecting the whole CLI list', async () => {
    const err = new Error('spawn EPERM') as NodeJS.ErrnoException
    err.code = 'EPERM'
    mockSpawn.mockImplementationOnce(() => {
      throw err
    })

    await expect(runStatusProbe('codex', ['--version'])).resolves.toMatchObject({
      exitCode: null,
      notFound: true,
      timedOut: false,
      stderr: 'spawn EPERM',
    })
  })

  it('settles when timeout cleanup cannot produce a close event', async () => {
    vi.useFakeTimers()
    try {
      const child = new MockChildProcess()
      mockSpawn.mockReturnValue(child)

      const resultPromise = runStatusProbe('codex', ['login', 'status'], { timeoutMs: 100 })
      await vi.advanceTimersByTimeAsync(100)

      await expect(resultPromise).resolves.toMatchObject({
        exitCode: null,
        timedOut: true,
        notFound: false,
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not inherit unknown API-process secrets by default', async () => {
    const previous = process.env.LOGIN_PROBE_UNKNOWN_SECRET
    process.env.LOGIN_PROBE_UNKNOWN_SECRET = 'must-not-leak'
    try {
      const child = new MockChildProcess()
      mockSpawn.mockReturnValue(child)
      const promise = runStatusProbe('codex', ['login', 'status'])
      settle(child, 'ok', 0)
      await promise

      const spawnEnv = (mockSpawn.mock.calls.at(-1)?.[2] as { env: NodeJS.ProcessEnv }).env
      expect(spawnEnv.LOGIN_PROBE_UNKNOWN_SECRET).toBeUndefined()
      expect(spawnEnv.PATH).toBe(process.env.PATH)
    } finally {
      if (previous === undefined) {
        Reflect.deleteProperty(process.env, 'LOGIN_PROBE_UNKNOWN_SECRET')
      } else process.env.LOGIN_PROBE_UNKNOWN_SECRET = previous
    }
  })

  it('preserves explicitly supplied temporary Provider credentials', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const promise = runStatusProbe('cursor-agent', ['status'], {
      env: { CURSOR_API_KEY: 'temporary-provider-key' },
    })
    settle(child, 'ok', 0)
    await promise

    const spawnEnv = (mockSpawn.mock.calls.at(-1)?.[2] as { env: NodeJS.ProcessEnv }).env
    expect(spawnEnv.CURSOR_API_KEY).toBe('temporary-provider-key')
    expect(spawnEnv.PATH).toBe(process.env.PATH)
  })

  it('spawns with the complete env as-is, without merging process.env back in', async () => {
    // The Kimi probe/execution env parity depends on this: a variable removed
    // by the engine's env constructor must NOT reappear from process.env.
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)

    const promise = runStatusProbe('kimi', ['provider', 'list', '--json'], {
      completeEnv: { PATH: '/usr/bin', HOME: '/home/operator' },
    })
    settle(child, '{"providers":{},"models":{}}', 0)
    await promise

    const spawnEnv = (mockSpawn.mock.calls.at(-1)?.[2] as { env: NodeJS.ProcessEnv }).env
    expect(spawnEnv).toEqual({ PATH: '/usr/bin', HOME: '/home/operator' })
  })
})
