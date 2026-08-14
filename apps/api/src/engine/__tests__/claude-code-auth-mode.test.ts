import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockLoggerInfo, mockSpawn } = vi.hoisted(() => ({
  mockLoggerInfo: vi.fn(),
  mockSpawn: vi.fn(),
}))

vi.mock('../cli-spawn.js', () => ({ spawnCli: mockSpawn }))

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
  spawn: mockSpawn,
}))

vi.mock('../../lib/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: mockLoggerInfo,
    warn: vi.fn(),
  },
}))

import { unsetEnv } from '../../lib/env-utils.js'
import { ClaudeCodeEngine } from '../claude-code.js'

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
  pid = 5151
  kill = vi.fn()
}

type StreamRequest = Record<string, unknown>

function getExecuteStream(engine: ClaudeCodeEngine) {
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

describe('ClaudeCodeEngine auth mode', () => {
  const originals = {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
    ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
    CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
    HOME: process.env.HOME,
  }

  beforeEach(() => {
    unsetEnv(process.env, 'ANTHROPIC_API_KEY')
    unsetEnv(process.env, 'ANTHROPIC_AUTH_TOKEN')
    unsetEnv(process.env, 'ANTHROPIC_BASE_URL')
    unsetEnv(process.env, 'CLAUDE_CODE_OAUTH_TOKEN')
  })

  afterEach(() => {
    vi.clearAllMocks()
    for (const [k, v] of Object.entries(originals)) {
      if (v === undefined) unsetEnv(process.env, k)
      else (process.env as Record<string, string>)[k] = v
    }
  })

  it('apiKey mode preserves legacy sk-* credentials and the configured Base URL', async () => {
    process.env.ANTHROPIC_AUTH_TOKEN = 'inherited-bearer-token'
    process.env.ANTHROPIC_BASE_URL = 'https://inherited.example.com'
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'inherited-oauth-token'
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)

    const engine = new ClaudeCodeEngine(engineConfig)
    const p = getExecuteStream(engine)(
      {
        taskId: 't1',
        workDir: '/tmp',
        prompt: 'hi',
        agentConfig: {
          authMode: 'apiKey',
          providerApiKey: 'sk-legacy-proxy-key',
          providerBaseUrl: 'https://api.example.com/hdp/v1',
        },
      },
      'claude-sonnet-4-6',
    )
    finishRunSuccessfully(child)
    await p

    const env = lastSpawnEnv()
    expect(env.ANTHROPIC_API_KEY).toBe('sk-legacy-proxy-key')
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.example.com/hdp/v1')
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()

    const executeLog = mockLoggerInfo.mock.calls.find(
      ([, message]) => message === '[claude-code] execute (stream) params',
    )
    expect(executeLog?.[0]).toMatchObject({ apiKey: '***' })
    expect(JSON.stringify(executeLog?.[0])).not.toContain('sk-legacy')
  })

  it('apiKey mode keeps an opaque legacy key on x-api-key when no header style is saved', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)

    const engine = new ClaudeCodeEngine(engineConfig)
    const p = getExecuteStream(engine)(
      {
        taskId: 't1-legacy-opaque',
        workDir: '/tmp',
        prompt: 'hi',
        agentConfig: {
          authMode: 'apiKey',
          providerApiKey: 'opaque-legacy-key',
          providerBaseUrl: 'https://api.example.com/hdp/v1',
        },
      },
      'deepseek-v4-flash',
    )
    finishRunSuccessfully(child)
    await p

    const env = lastSpawnEnv()
    expect(env.ANTHROPIC_API_KEY).toBe('opaque-legacy-key')
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.example.com/hdp/v1')
  })

  it('apiKey mode uses explicit Bearer auth and normalizes trailing /v1', async () => {
    process.env.ANTHROPIC_API_KEY = 'inherited-api-key'
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)

    const engine = new ClaudeCodeEngine(engineConfig)
    const p = getExecuteStream(engine)(
      {
        taskId: 't1',
        workDir: '/tmp',
        prompt: 'hi',
        agentConfig: {
          authMode: 'apiKey',
          authHeaderStyle: 'bearer',
          providerApiKey: 'opaque-proxy-token',
          providerBaseUrl: 'https://api.example.com/hdp/v1/',
        },
      },
      'deepseek-v4-flash',
    )
    finishRunSuccessfully(child)
    await p

    const env = lastSpawnEnv()
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('opaque-proxy-token')
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.example.com/hdp')

    const executeLog = mockLoggerInfo.mock.calls.find(
      ([, message]) => message === '[claude-code] execute (stream) params',
    )
    expect(executeLog?.[0]).toMatchObject({ apiKey: '***' })
    expect(JSON.stringify(executeLog?.[0])).not.toContain('opaque-p')
  })

  it('apiKey mode applies explicit Bearer auth to global engine config', async () => {
    process.env.ANTHROPIC_BASE_URL = 'https://inherited.example.com'
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)

    const engine = new ClaudeCodeEngine({
      ...engineConfig,
      apiKey: 'global-opaque-token',
      baseUrl: 'https://api.example.com/hdp/v1',
    })
    const p = getExecuteStream(engine)(
      {
        taskId: 't1-global',
        workDir: '/tmp',
        prompt: 'hi',
        agentConfig: { authMode: 'apiKey', authHeaderStyle: 'bearer' },
      },
      'deepseek-v4-flash',
    )
    finishRunSuccessfully(child)
    await p

    const env = lastSpawnEnv()
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('global-opaque-token')
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.example.com/hdp')
  })

  it.each(['bearer', 'x-api-key'] as const)(
    'apiKey mode does not inherit process credentials or Base URL when an explicit %s key is empty',
    async (authHeaderStyle) => {
      process.env.ANTHROPIC_API_KEY = 'inherited-api-key'
      process.env.ANTHROPIC_AUTH_TOKEN = 'inherited-bearer-token'
      process.env.ANTHROPIC_BASE_URL = 'https://inherited.example.com'
      const child = new MockChildProcess()
      mockSpawn.mockReturnValue(child)

      const engine = new ClaudeCodeEngine(engineConfig)
      const p = getExecuteStream(engine)(
        {
          taskId: `t1-empty-${authHeaderStyle}`,
          workDir: '/tmp',
          prompt: 'hi',
          agentConfig: { authMode: 'apiKey', authHeaderStyle },
        },
        'deepseek-v4-flash',
      )
      finishRunSuccessfully(child)
      await p

      const env = lastSpawnEnv()
      expect(env.ANTHROPIC_API_KEY).toBeUndefined()
      expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
      expect(env.ANTHROPIC_BASE_URL).toBeUndefined()
    },
  )

  it('apiKey mode leaves an explicit Bearer Base URL without trailing /v1 unchanged', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)

    const engine = new ClaudeCodeEngine(engineConfig)
    const p = getExecuteStream(engine)(
      {
        taskId: 't1-no-v1',
        workDir: '/tmp',
        prompt: 'hi',
        agentConfig: {
          authMode: 'apiKey',
          authHeaderStyle: 'bearer',
          providerApiKey: 'opaque-proxy-token',
          providerBaseUrl: 'https://api.example.com/hdp',
        },
      },
      'deepseek-v4-flash',
    )
    finishRunSuccessfully(child)
    await p

    const env = lastSpawnEnv()
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('opaque-proxy-token')
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.example.com/hdp')
  })

  it('localSession mode strips ANTHROPIC_API_KEY / AUTH_TOKEN / BASE_URL / CLAUDE_CODE_OAUTH_TOKEN from inherited env', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-leak'
    process.env.ANTHROPIC_AUTH_TOKEN = 'tok-leak'
    process.env.ANTHROPIC_BASE_URL = 'https://leak.example.com'
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oat-leak'
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)

    const engine = new ClaudeCodeEngine({
      ...engineConfig,
      apiKey: 'sk-engine',
      baseUrl: 'https://engine.example.com',
    })
    const p = getExecuteStream(engine)(
      {
        taskId: 't2',
        workDir: '/tmp',
        prompt: 'hi',
        agentConfig: { authMode: 'localSession' },
      },
      'claude-sonnet-4-6',
    )
    finishRunSuccessfully(child)
    await p

    const env = lastSpawnEnv()
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined()
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
  })

  it('localSession mode ignores per-agent providerApiKey/baseUrl even if supplied', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)

    const engine = new ClaudeCodeEngine(engineConfig)
    const p = getExecuteStream(engine)(
      {
        taskId: 't3',
        workDir: '/tmp',
        prompt: 'hi',
        agentConfig: {
          authMode: 'localSession',
          providerApiKey: 'sk-ignored',
          providerBaseUrl: 'https://ignored.example.com',
        },
      },
      'claude-sonnet-4-6',
    )
    finishRunSuccessfully(child)
    await p

    const env = lastSpawnEnv()
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined()
  })

  it('oauth mode injects CLAUDE_CODE_OAUTH_TOKEN and strips ANTHROPIC_API_KEY / AUTH_TOKEN / BASE_URL (token bound to api.anthropic.com)', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-leak'
    process.env.ANTHROPIC_AUTH_TOKEN = 'tok-leak'
    process.env.ANTHROPIC_BASE_URL = 'https://leak.example.com'
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)

    const engine = new ClaudeCodeEngine({
      ...engineConfig,
      apiKey: 'sk-engine-fallback',
      baseUrl: 'https://engine.example.com',
    })
    const p = getExecuteStream(engine)(
      {
        taskId: 't-oauth-1',
        workDir: '/tmp',
        prompt: 'hi',
        agentConfig: {
          authMode: 'oauth',
          providerOauthToken: 'sk-ant-oat01-token',
        },
      },
      'claude-sonnet-4-6',
    )
    finishRunSuccessfully(child)
    await p

    const env = lastSpawnEnv()
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-token')
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined()
  })

  it('oauth mode without per-agent token leaves CLAUDE_CODE_OAUTH_TOKEN unset (no global fallback)', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)

    const engine = new ClaudeCodeEngine(engineConfig)
    const p = getExecuteStream(engine)(
      {
        taskId: 't-oauth-2',
        workDir: '/tmp',
        prompt: 'hi',
        agentConfig: { authMode: 'oauth' },
      },
      'claude-sonnet-4-6',
    )
    finishRunSuccessfully(child)
    await p

    const env = lastSpawnEnv()
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
  })

  it('oauth mode 不会从宿主 process.env 继承 CLAUDE_CODE_OAUTH_TOKEN', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'token-from-host'
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)

    const engine = new ClaudeCodeEngine(engineConfig)
    const p = getExecuteStream(engine)(
      {
        taskId: 't-oauth-3',
        workDir: '/tmp',
        prompt: 'hi',
        agentConfig: { authMode: 'oauth' },
      },
      'claude-sonnet-4-6',
    )
    finishRunSuccessfully(child)
    await p

    const env = lastSpawnEnv()
    // 期望：authMode='oauth' 但未填 token 时，子进程不能拿到宿主机的 token
    // 否则任意 agent 都能蹭宿主机凭证执行，凭证模式隔离失效
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
  })

  it('agentEnv 不能覆盖 authMode 的凭证隔离（localSession + agentEnv 注入 token 仍被剥）', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)

    const engine = new ClaudeCodeEngine(engineConfig)
    const p = getExecuteStream(engine)(
      {
        taskId: 't-localsession-evade',
        workDir: '/tmp',
        prompt: 'hi',
        agentConfig: {
          authMode: 'localSession',
          agentEnv: {
            CLAUDE_CODE_OAUTH_TOKEN: 'token-from-agent-env',
            ANTHROPIC_API_KEY: 'key-from-agent-env',
            ANTHROPIC_AUTH_TOKEN: 'auth-from-agent-env',
            ANTHROPIC_BASE_URL: 'https://from-agent-env.example.com',
            CUSTOM_VAR: 'should-pass-through',
          },
        },
      },
      'claude-sonnet-4-6',
    )
    finishRunSuccessfully(child)
    await p

    const env = lastSpawnEnv()
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined()
    // 非凭证类的 agentEnv 字段照常透传，不会被殃及
    expect(env.CUSTOM_VAR).toBe('should-pass-through')
  })

  it('localSession mode keeps process HOME for local login state when runtime env is present', async () => {
    process.env.HOME = '/login-home'
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)

    const engine = new ClaudeCodeEngine(engineConfig)
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
          },
        },
      },
      'claude-sonnet-4-6',
    )
    finishRunSuccessfully(child)
    await p

    const env = lastSpawnEnv()
    expect(env.HOME).toBe('/login-home')
    expect(env.A2WAVE_AGENT_HOME).toBe('/runtime/agt_runtime')
    expect(env.TMPDIR).toBe('/runtime/agt_runtime/tmp')
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
  })

  it('agentEnv 也不能覆盖 oauth 模式的 token 注入', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)

    const engine = new ClaudeCodeEngine(engineConfig)
    const p = getExecuteStream(engine)(
      {
        taskId: 't-oauth-evade',
        workDir: '/tmp',
        prompt: 'hi',
        agentConfig: {
          authMode: 'oauth',
          providerOauthToken: 'sk-ant-oat01-real',
          agentEnv: {
            CLAUDE_CODE_OAUTH_TOKEN: 'attacker-token',
            ANTHROPIC_API_KEY: 'attacker-key',
          },
        },
      },
      'claude-sonnet-4-6',
    )
    finishRunSuccessfully(child)
    await p

    const env = lastSpawnEnv()
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-real')
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
  })

  it('runtime env owns HOME/cache/tmp and is visible in exec params', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const logs: Array<{ type: string; params?: Record<string, unknown> }> = []
    const runtimeContext = makeRuntimeContext()

    const engine = new ClaudeCodeEngine(engineConfig)
    const p = getExecuteStream(engine)(
      {
        taskId: 't-runtime',
        workDir: '/tmp',
        prompt: 'hi',
        runtimeContext,
        onLogEntry: (entry: { type: string; params?: Record<string, unknown> }) => {
          logs.push(entry)
        },
        agentConfig: {
          authMode: 'oauth',
          providerOauthToken: 'sk-ant-oat01-real',
          agentEnv: {
            HOME: '/agent-home-should-not-win',
            TMPDIR: '/agent-tmp-should-not-win',
            XDG_CACHE_HOME: '/agent-cache-should-not-win',
            CUSTOM_VAR: 'kept',
          },
        },
      },
      'claude-sonnet-4-6',
    )
    finishRunSuccessfully(child)
    await p

    const env = lastSpawnEnv()
    expect(env.HOME).toBe('/runtime/agt_runtime')
    expect(env.TMPDIR).toBe('/runtime/agt_runtime/tmp')
    expect(env.XDG_CACHE_HOME).toBe('/runtime/agt_runtime/.cache')
    expect(env.CUSTOM_VAR).toBe('kept')
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-real')
    expect(logs.find((entry) => entry.type === 'exec_params')?.params?.runtimeHome).toBeUndefined()
    expect(logs.find((entry) => entry.type === 'exec_params')?.params).toMatchObject({
      workspaceDir: '/workspace/agt_runtime',
      workspaceType: 'temp',
      artifactsDir: '/workspace/agt_runtime/artifacts',
    })
  })
})
