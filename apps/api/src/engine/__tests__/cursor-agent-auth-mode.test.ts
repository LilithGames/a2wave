import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockSpawn = vi.hoisted(() => vi.fn())

vi.mock('../cli-spawn.js', () => ({ spawnCli: mockSpawn }))

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
  spawn: mockSpawn,
}))

import { unsetEnv } from '../../lib/env-utils.js'
import { CursorAgentEngine } from '../cursor-agent.js'

const engineConfig = {
  apiKey: '',
  timeoutMinutes: 5,
  agentForce: false,
  approveMcps: false,
  defaultWorkDir: '/tmp',
}

class MockChildProcess extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  stdin = null
  pid = 6161
  kill = vi.fn()
}

type StreamRequest = Record<string, unknown>

function getExecuteStream(engine: CursorAgentEngine) {
  return (
    engine as unknown as {
      executeStreamWithModel: (request: StreamRequest, model: string) => Promise<{ output: string }>
    }
  ).executeStreamWithModel.bind(engine)
}

function finishRunSuccessfully(child: MockChildProcess) {
  child.stdout.write(
    `${JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: 'ok',
      duration_ms: 10,
    })}\n`,
  )
  child.emit('close', 0)
}

function lastSpawnEnv(): NodeJS.ProcessEnv {
  const call = mockSpawn.mock.calls.at(-1)
  if (!call) throw new Error('spawn was not called')
  return (call[2] as { env: NodeJS.ProcessEnv }).env
}

function makeRuntimeContext() {
  return {
    agentId: 'agt_runtime',
    runId: 'run_runtime',
    workspace: {
      dir: '/workspace/agt_runtime',
      type: 'temp',
      cleanup: 'ttl',
    },
    home: {
      dir: '/runtime/agt_runtime',
      cacheDir: '/runtime/agt_runtime/.cache',
      configDir: '/runtime/agt_runtime/.config',
      tmpDir: '/runtime/agt_runtime/tmp',
      claudeDir: '/runtime/agt_runtime/.claude',
      codexHomeDir: '/runtime/agt_runtime/.codex',
    },
    artifacts: {
      dir: '/workspace/agt_runtime/artifacts',
    },
    env: {
      HOME: '/runtime/agt_runtime',
      A2WAVE_AGENT_HOME: '/runtime/agt_runtime',
      A2WAVE_AGENT_ID: 'agt_runtime',
      A2WAVE_RUN_ID: 'run_runtime',
      A2WAVE_WORKSPACE_DIR: '/workspace/agt_runtime',
      A2WAVE_ARTIFACTS_DIR: '/workspace/agt_runtime/artifacts',
      XDG_CACHE_HOME: '/runtime/agt_runtime/.cache',
      XDG_CONFIG_HOME: '/runtime/agt_runtime/.config',
      TMPDIR: '/runtime/agt_runtime/tmp',
      CODEX_HOME: '/runtime/agt_runtime/.codex',
    },
  }
}

describe('CursorAgentEngine auth mode', () => {
  const originalCursor = process.env.CURSOR_API_KEY
  const originalHome = process.env.HOME

  beforeEach(() => {
    unsetEnv(process.env, 'CURSOR_API_KEY')
  })

  afterEach(() => {
    vi.clearAllMocks()
    if (originalCursor === undefined) unsetEnv(process.env, 'CURSOR_API_KEY')
    else process.env.CURSOR_API_KEY = originalCursor
    if (originalHome === undefined) unsetEnv(process.env, 'HOME')
    else process.env.HOME = originalHome
  })

  it('apiKey mode injects per-agent CURSOR_API_KEY', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)

    const engine = new CursorAgentEngine(engineConfig)
    const p = getExecuteStream(engine)(
      {
        taskId: 't1',
        workDir: '/tmp',
        prompt: 'hi',
        agentConfig: { authMode: 'apiKey', providerApiKey: 'cur-agent' },
      },
      'composer-1',
    )
    finishRunSuccessfully(child)
    await p

    const env = lastSpawnEnv()
    expect(env.CURSOR_API_KEY).toBe('cur-agent')
  })

  it('localSession mode strips inherited parent-process CURSOR_API_KEY', async () => {
    process.env.CURSOR_API_KEY = 'cur-parent-leak'
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)

    const engine = new CursorAgentEngine({ ...engineConfig, apiKey: 'cur-engine' })
    const p = getExecuteStream(engine)(
      {
        taskId: 't2',
        workDir: '/tmp',
        prompt: 'hi',
        agentConfig: { authMode: 'localSession' },
      },
      'composer-1',
    )
    finishRunSuccessfully(child)
    await p

    const env = lastSpawnEnv()
    expect(env.CURSOR_API_KEY).toBeUndefined()
  })

  it('localSession mode ignores per-agent providerApiKey', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)

    const engine = new CursorAgentEngine(engineConfig)
    const p = getExecuteStream(engine)(
      {
        taskId: 't3',
        workDir: '/tmp',
        prompt: 'hi',
        agentConfig: {
          authMode: 'localSession',
          providerApiKey: 'cur-ignored',
        },
      },
      'composer-1',
    )
    finishRunSuccessfully(child)
    await p

    const env = lastSpawnEnv()
    expect(env.CURSOR_API_KEY).toBeUndefined()
  })

  it('localSession mode keeps process HOME for local login state when runtime env is present', async () => {
    process.env.HOME = '/login-home'
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)

    const engine = new CursorAgentEngine(engineConfig)
    const p = getExecuteStream(engine)(
      {
        taskId: 't-localsession-runtime-home',
        workDir: '/tmp',
        prompt: 'hi',
        runtimeContext: makeRuntimeContext(),
        agentConfig: {
          authMode: 'localSession',
          agentEnv: {
            HOME: '/agent-home-should-not-win',
            CURSOR_API_KEY: 'cur-agent-env-should-not-win',
          },
        },
      },
      'composer-1',
    )
    finishRunSuccessfully(child)
    await p

    const env = lastSpawnEnv()
    expect(env.HOME).toBe('/login-home')
    expect(env.A2WAVE_AGENT_HOME).toBe('/runtime/agt_runtime')
    expect(env.TMPDIR).toBe('/runtime/agt_runtime/tmp')
    expect(env.CURSOR_API_KEY).toBeUndefined()
  })

  it('runtime env owns HOME/cache/tmp while keeping non-runtime agent env', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)

    const engine = new CursorAgentEngine(engineConfig)
    const p = getExecuteStream(engine)(
      {
        taskId: 't-runtime',
        workDir: '/tmp',
        prompt: 'hi',
        runtimeContext: makeRuntimeContext(),
        agentConfig: {
          authMode: 'apiKey',
          providerApiKey: 'cur-agent',
          agentEnv: {
            HOME: '/agent-home-should-not-win',
            TMPDIR: '/agent-tmp-should-not-win',
            XDG_CACHE_HOME: '/agent-cache-should-not-win',
            SAFE_VALUE: 'kept',
          },
        },
      },
      'composer-1',
    )
    finishRunSuccessfully(child)
    await p

    const env = lastSpawnEnv()
    expect(env.HOME).toBe('/runtime/agt_runtime')
    expect(env.TMPDIR).toBe('/runtime/agt_runtime/tmp')
    expect(env.XDG_CACHE_HOME).toBe('/runtime/agt_runtime/.cache')
    expect(env.SAFE_VALUE).toBe('kept')
    expect(env.CURSOR_API_KEY).toBe('cur-agent')
  })
})
