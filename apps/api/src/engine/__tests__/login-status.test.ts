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
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const promise = engine.checkLoginStatus()
    settle(child, 'Logged in using ChatGPT\n', 0)
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
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const promise = engine.checkLoginStatus()
    settle(child, '\n\n  Logged in using ChatGPT  \n\n', 0)
    const status = await promise
    expect(status.loggedIn).toBe(true)
    expect(status.method).toBe('ChatGPT')
  })

  it('falls back to stderr when stdout is empty', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const promise = engine.checkLoginStatus()
    child.stderr.write('Logged in using ChatGPT\n')
    child.stderr.end()
    child.stdout.end()
    child.emit('close', 0)
    const status = await promise
    expect(status.loggedIn).toBe(true)
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
