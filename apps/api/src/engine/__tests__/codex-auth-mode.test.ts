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
import { CodexAgentEngine } from '../codex-agent.js'

const engineConfig = {
  path: 'codex',
  apiKey: '',
  timeoutMinutes: 5,
  force: true,
  approveMcps: true,
  defaultWorkDir: '/tmp',
}

class MockChildProcess extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  stdin = null
  pid = 4242
  kill = vi.fn()
}

type StreamRequest = Record<string, unknown>

function getExecuteStream(engine: CodexAgentEngine) {
  return (
    engine as unknown as {
      executeStreamWithModel: (request: StreamRequest, model: string) => Promise<{ output: string }>
    }
  ).executeStreamWithModel.bind(engine)
}

/** Fire a minimal successful run so the promise settles. */
function finishRunSuccessfully(child: MockChildProcess) {
  child.stdout.write(`${JSON.stringify({ type: 'thread.started', thread_id: 'th_x' })}\n`)
  child.stdout.write(`${JSON.stringify({ type: 'turn.completed' })}\n`)
  child.emit('close', 0)
}

/** Get the env passed to spawn on the most recent invocation. */
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

describe('CodexAgentEngine auth mode', () => {
  const originalOpenAI = process.env.OPENAI_API_KEY
  const originalCodex = process.env.CODEX_API_KEY
  const originalHome = process.env.HOME
  const originalCodexHome = process.env.CODEX_HOME

  beforeEach(() => {
    unsetEnv(process.env, 'OPENAI_API_KEY')
    unsetEnv(process.env, 'CODEX_API_KEY')
  })

  afterEach(() => {
    vi.clearAllMocks()
    if (originalOpenAI === undefined) unsetEnv(process.env, 'OPENAI_API_KEY')
    else process.env.OPENAI_API_KEY = originalOpenAI
    if (originalCodex === undefined) unsetEnv(process.env, 'CODEX_API_KEY')
    else process.env.CODEX_API_KEY = originalCodex
    if (originalHome === undefined) unsetEnv(process.env, 'HOME')
    else process.env.HOME = originalHome
    if (originalCodexHome === undefined) unsetEnv(process.env, 'CODEX_HOME')
    else process.env.CODEX_HOME = originalCodexHome
  })

  it('apiKey mode injects per-agent key into OPENAI_API_KEY and CODEX_API_KEY', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)

    const engine = new CodexAgentEngine(engineConfig)
    const p = getExecuteStream(engine)(
      {
        taskId: 't1',
        workDir: '/tmp',
        prompt: 'hi',
        agentConfig: { authMode: 'apiKey', providerApiKey: 'sk-agent' },
      },
      'gpt-5-codex',
    )
    finishRunSuccessfully(child)
    await p

    const env = lastSpawnEnv()
    expect(env.OPENAI_API_KEY).toBe('sk-agent')
    expect(env.CODEX_API_KEY).toBe('sk-agent')
  })

  it('apiKey mode with no per-agent key falls back to engine config apiKey', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)

    const engine = new CodexAgentEngine({ ...engineConfig, apiKey: 'sk-engine-default' })
    const p = getExecuteStream(engine)(
      {
        taskId: 't2',
        workDir: '/tmp',
        prompt: 'hi',
        agentConfig: { authMode: 'apiKey' },
      },
      'gpt-5-codex',
    )
    finishRunSuccessfully(child)
    await p

    const env = lastSpawnEnv()
    expect(env.OPENAI_API_KEY).toBe('sk-engine-default')
    expect(env.CODEX_API_KEY).toBe('sk-engine-default')
  })

  it('localSession mode strips inherited parent-process OPENAI_API_KEY / CODEX_API_KEY', async () => {
    process.env.OPENAI_API_KEY = 'sk-parent-leak'
    process.env.CODEX_API_KEY = 'sk-parent-leak-codex'
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)

    const engine = new CodexAgentEngine({ ...engineConfig, apiKey: 'sk-engine' })
    const p = getExecuteStream(engine)(
      {
        taskId: 't3',
        workDir: '/tmp',
        prompt: 'hi',
        agentConfig: { authMode: 'localSession' },
      },
      'gpt-5-codex',
    )
    finishRunSuccessfully(child)
    await p

    const env = lastSpawnEnv()
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.CODEX_API_KEY).toBeUndefined()
  })

  it('localSession mode ignores per-agent providerApiKey even if supplied', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)

    const engine = new CodexAgentEngine(engineConfig)
    const p = getExecuteStream(engine)(
      {
        taskId: 't4',
        workDir: '/tmp',
        prompt: 'hi',
        agentConfig: {
          authMode: 'localSession',
          providerApiKey: 'sk-should-be-ignored',
        },
      },
      'gpt-5-codex',
    )
    finishRunSuccessfully(child)
    await p

    const env = lastSpawnEnv()
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.CODEX_API_KEY).toBeUndefined()
  })

  it('localSession mode strips credential keys from agent env overrides', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)

    const engine = new CodexAgentEngine(engineConfig)
    const p = getExecuteStream(engine)(
      {
        taskId: 't5',
        workDir: '/tmp',
        prompt: 'hi',
        agentConfig: {
          authMode: 'localSession',
          agentEnv: {
            OPENAI_API_KEY: 'sk-agent-env-leak',
            CODEX_API_KEY: 'sk-agent-env-leak-codex',
            SAFE_VALUE: 'kept',
          },
        },
      },
      'gpt-5-codex',
    )
    finishRunSuccessfully(child)
    await p

    const env = lastSpawnEnv()
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.CODEX_API_KEY).toBeUndefined()
    expect(env.SAFE_VALUE).toBe('kept')
  })

  it('localSession mode keeps process HOME and CODEX_HOME for local login state', async () => {
    process.env.HOME = '/login-home'
    process.env.CODEX_HOME = '/login-codex-home'
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)

    const engine = new CodexAgentEngine(engineConfig)
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
            CODEX_HOME: '/agent-codex-should-not-win',
          },
        },
      },
      'gpt-5-codex',
    )
    finishRunSuccessfully(child)
    await p

    const env = lastSpawnEnv()
    expect(env.HOME).toBe('/login-home')
    expect(env.CODEX_HOME).toBe('/login-codex-home')
    expect(env.A2WAVE_AGENT_HOME).toBe('/runtime/agt_runtime')
    expect(env.TMPDIR).toBe('/runtime/agt_runtime/tmp')
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.CODEX_API_KEY).toBeUndefined()
  })

  it('runtime env owns HOME and CODEX_HOME after agent and MCP env are sanitized', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const runtimeContext = makeRuntimeContext()

    const engine = new CodexAgentEngine(engineConfig)
    const p = getExecuteStream(engine)(
      {
        taskId: 't-runtime',
        workDir: '/tmp',
        prompt: 'hi',
        runtimeContext,
        agentConfig: {
          authMode: 'apiKey',
          providerApiKey: 'sk-agent',
          agentEnv: {
            HOME: '/agent-home-should-not-win',
            CODEX_HOME: '/agent-codex-should-not-win',
            XDG_CONFIG_HOME: '/agent-config-should-not-win',
            SAFE_VALUE: 'kept',
          },
        },
      },
      'gpt-5-codex',
    )
    finishRunSuccessfully(child)
    await p

    const env = lastSpawnEnv()
    expect(env.HOME).toBe('/runtime/agt_runtime')
    expect(env.CODEX_HOME).toBe('/runtime/agt_runtime/.codex')
    expect(env.XDG_CONFIG_HOME).toBe('/runtime/agt_runtime/.config')
    expect(env.SAFE_VALUE).toBe('kept')
    expect(env.OPENAI_API_KEY).toBe('sk-agent')
    expect(env.CODEX_API_KEY).toBe('sk-agent')
  })
})
