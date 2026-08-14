import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockSpawn = vi.hoisted(() => vi.fn())
const mockRunStatusProbe = vi.hoisted(() => vi.fn())
const mockDnsLookup = vi.hoisted(() => vi.fn())

vi.mock('../cli-spawn.js', () => ({ spawnCli: mockSpawn }))

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
  spawn: mockSpawn,
}))
vi.mock('node:dns/promises', () => ({
  lookup: (...args: unknown[]) => mockDnsLookup(...args),
}))
vi.mock('../../env.js', () => ({
  env: {
    TRUSTED_IMPORT_HOSTS: '',
    TRUSTED_PROVIDER_HOSTS: 'trusted-provider.example.com',
  },
}))
vi.mock('../login-status-helper.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../login-status-helper.js')>()
  return { ...actual, runStatusProbe: mockRunStatusProbe }
})

import { stripPromptArg } from '../cli-engine-base.js'
import { TraeAgentEngine } from '../trae-agent.js'

beforeEach(() => {
  mockDnsLookup.mockReset()
  mockDnsLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }])
})

const baseConfig = {
  path: 'traecli',
  apiKey: '',
  host: '',
  timeoutMinutes: 5,
  force: false,
  approveMcps: true,
  defaultWorkDir: '/tmp',
}

class MockChildProcess extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  stdin = null
  pid = 33000
  kill = vi.fn()
}

type StreamRequest = Record<string, unknown>

function getExecuteStream(engine: TraeAgentEngine) {
  return (
    engine as unknown as {
      executeStreamWithModel: (
        request: StreamRequest,
        model: string,
      ) => Promise<{ output: string; chatId?: string; success: boolean }>
    }
  ).executeStreamWithModel.bind(engine)
}

function line(obj: Record<string, unknown>): string {
  return `${JSON.stringify(obj)}\n`
}

/** Minimal success replay (event shape observed with traecli 0.120.42): init → assistant → result → close 0 */
function finishOk(child: MockChildProcess, sessionId = 'ses_t1', text = 'PONG') {
  child.stdout.write(line({ type: 'system', subtype: 'init', session_id: sessionId }))
  child.stdout.write(line({ type: 'assistant', message: { content: [{ type: 'text', text }] } }))
  child.stdout.write(
    line({ type: 'result', subtype: 'success', session_id: sessionId, is_error: false }),
  )
  child.emit('close', 0)
}

function lastSpawnArgs(): string[] {
  const call = mockSpawn.mock.calls.at(-1)
  if (!call) throw new Error('spawn not called')
  return call[1] as string[]
}

function lastSpawnEnv(): NodeJS.ProcessEnv {
  const call = mockSpawn.mock.calls.at(-1)
  if (!call) throw new Error('spawn not called')
  return (call[2] as { env: NodeJS.ProcessEnv }).env
}

function probeResult(overrides: Record<string, unknown>) {
  return { notFound: false, timedOut: false, exitCode: 0, stdout: '', stderr: '', ...overrides }
}

afterEach(() => vi.clearAllMocks())

// ============================================================
// args
// ============================================================

describe('TraeAgentEngine args', () => {
  it('basic invocation: -p <prompt> --output-format stream-json; the model is injected via -c model.name=', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const engine = new TraeAgentEngine(baseConfig)
    const p = getExecuteStream(engine)(
      { taskId: 't', workDir: '/tmp/w', prompt: 'hi', agentConfig: {} },
      'kimi-k2',
    )
    finishOk(child)
    await p
    const args = lastSpawnArgs()
    expect(args.slice(0, 2)).toEqual(['-p', 'hi'])
    expect(args).toEqual(expect.arrayContaining(['--output-format', 'stream-json']))
    expect(args).toEqual(expect.arrayContaining(['-c', 'model.name=kimi-k2']))
    expect(args).toEqual(expect.arrayContaining(['--allowed-tool', 'mcp__*']))
    // CLI-side query timeout is aligned with the engine timeout
    expect(args).toEqual(expect.arrayContaining(['--query-timeout', '5m']))
    expect(args).not.toContain('-y')
  })

  it('force=true appends -y; chatId is passed via --resume; readOnly uses plan mode', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const engine = new TraeAgentEngine({ ...baseConfig, force: true })
    const p = getExecuteStream(engine)(
      {
        taskId: 't',
        workDir: '/tmp',
        prompt: 'hi',
        chatId: 'ses_prev',
        agentConfig: { readOnly: true },
      },
      'kimi-k2',
    )
    finishOk(child)
    await p
    const args = lastSpawnArgs()
    expect(args).toContain('-y')
    expect(args).toEqual(expect.arrayContaining(['--resume', 'ses_prev']))
    expect(args).toEqual(expect.arrayContaining(['--permission-mode', 'plan']))
  })

  it('stripPromptArg strips -p and the prompt plaintext', async () => {
    expect(stripPromptArg(['-p', 'secret', '-c', 'model.name=kimi-k2'])).toEqual([
      '-c',
      'model.name=kimi-k2',
    ])
  })
})

// ============================================================
// env (credential matrix)
// ============================================================

describe('TraeAgentEngine env', () => {
  it('apiKey mode injects TRAECLI_PERSONAL_ACCESS_TOKEN + TRAECLI_HOST (per-agent takes precedence)', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const engine = new TraeAgentEngine({
      ...baseConfig,
      apiKey: 'trae-lt-deploy',
      host: 'https://d.trae.cn',
    })
    const p = getExecuteStream(engine)(
      {
        taskId: 't',
        workDir: '/tmp',
        prompt: 'hi',
        agentConfig: {
          authMode: 'apiKey',
          providerApiKey: 'trae-lt-agent',
          providerBaseUrl: 'https://ent.trae.cn',
        },
      },
      'kimi-k2',
    )
    finishOk(child)
    await p
    const env = lastSpawnEnv()
    expect(env.TRAECLI_PERSONAL_ACCESS_TOKEN).toBe('trae-lt-agent')
    expect(env.TRAECLI_HOST).toBe('https://ent.trae.cn')
  })

  it('localSession mode unsets the token and does not override the host HOME / XDG_CONFIG_HOME', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    process.env.TRAECLI_PERSONAL_ACCESS_TOKEN = 'leaky'
    try {
      const engine = new TraeAgentEngine(baseConfig)
      const p = getExecuteStream(engine)(
        {
          taskId: 't',
          workDir: '/tmp',
          prompt: 'hi',
          agentConfig: { authMode: 'localSession' },
          runtimeContext: {
            env: {
              HOME: '/isolated/home',
              XDG_CONFIG_HOME: '/isolated/config',
              A2WAVE_RUN_ID: 'run_1',
            },
            home: { dir: '/isolated/home' },
            workspace: { dir: '/tmp', type: 'temp' },
            artifacts: { dir: '/tmp/a' },
          },
        },
        'kimi-k2',
      )
      finishOk(child)
      await p
      const env = lastSpawnEnv()
      expect(env.TRAECLI_PERSONAL_ACCESS_TOKEN).toBeUndefined()
      expect(env.HOME).not.toBe('/isolated/home')
      expect(env.XDG_CONFIG_HOME).not.toBe('/isolated/config')
      expect(env.A2WAVE_RUN_ID).toBe('run_1')
    } finally {
      delete process.env.TRAECLI_PERSONAL_ACCESS_TOKEN
    }
  })

  it('agentEnv must not carry credential env vars (including TRAECLI_HOST endpoint redirection)', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const engine = new TraeAgentEngine({ ...baseConfig, apiKey: 'trae-lt-deploy' })
    const p = getExecuteStream(engine)(
      {
        taskId: 't',
        workDir: '/tmp',
        prompt: 'hi',
        agentConfig: {
          authMode: 'apiKey',
          agentEnv: {
            TRAECLI_PERSONAL_ACCESS_TOKEN: 'evil',
            TRAECLI_HOST: 'https://attacker.example',
            MY_VAR: 'ok',
          },
        },
      },
      'kimi-k2',
    )
    finishOk(child)
    await p
    const env = lastSpawnEnv()
    expect(env.TRAECLI_PERSONAL_ACCESS_TOKEN).toBe('trae-lt-deploy')
    expect(env.TRAECLI_HOST).toBeUndefined()
    expect(env.MY_VAR).toBe('ok')
  })
})

// ============================================================
// close handling
// ============================================================

describe('TraeAgentEngine stream close handling', () => {
  it('success: resolves with the output and session_id as chatId', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const engine = new TraeAgentEngine(baseConfig)
    const p = getExecuteStream(engine)(
      { taskId: 't', workDir: '/tmp', prompt: 'hi', agentConfig: {} },
      'kimi-k2',
    )
    finishOk(child, 'ses_new', 'PONG')
    const result = await p
    expect(result.success).toBe(true)
    expect(result.output).toBe('PONG')
    expect(result.chatId).toBe('ses_new')
  })

  it('result usage is normalized and passed through to ExecuteResult.usage', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const engine = new TraeAgentEngine(baseConfig)
    const p = getExecuteStream(engine)(
      { taskId: 't', workDir: '/tmp', prompt: 'hi', agentConfig: {} },
      'kimi-k2',
    )
    child.stdout.write(line({ type: 'system', subtype: 'init', session_id: 'ses_u' }))
    child.stdout.write(
      line({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'PONG',
        usage: { input_tokens: 7, output_tokens: 21, cache_creation_input_tokens: 3 },
      }),
    )
    child.emit('close', 0)
    const result = await p
    expect((result as { usage?: unknown }).usage).toEqual({
      inputTokens: 7,
      outputTokens: 21,
      cacheWriteTokens: 3,
    })
  })

  it('result is_error + error field (logged-out shape observed) → rejects with the error text', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const engine = new TraeAgentEngine(baseConfig)
    const p = getExecuteStream(engine)(
      { taskId: 't', workDir: '/tmp', prompt: 'hi', agentConfig: {} },
      '',
    )
    child.stdout.write(line({ type: 'system', subtype: 'init', session_id: 's' }))
    child.stdout.write(
      line({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        error: 'failed to create agent: Models is required',
      }),
    )
    child.emit('close', 1)
    await expect(p).rejects.toThrow(/Models is required/)
  })
})

// ============================================================
// probes (models)
// ============================================================

describe('TraeAgentEngine.checkLoginStatus', () => {
  it('model lines present → loggedIn=true (logged in + enterprise has models configured)', async () => {
    mockRunStatusProbe.mockResolvedValue(probeResult({ stdout: 'kimi-k2\ndoubao-seed-2.0\n' }))
    const engine = new TraeAgentEngine(baseConfig)
    const status = await engine.checkLoginStatus()
    expect(status).toMatchObject({ installed: true, loggedIn: true })
    expect(status.detail).toContain('2 model')
  })

  it('empty output (logged-out shape observed, exit 0) → loggedIn=false with guidance', async () => {
    mockRunStatusProbe.mockResolvedValue(probeResult({ stdout: '' }))
    const engine = new TraeAgentEngine(baseConfig)
    const status = await engine.checkLoginStatus()
    expect(status.loggedIn).toBe(false)
    expect(status.error).toMatch(/login|TRAECLI_PERSONAL_ACCESS_TOKEN/)
  })

  it('CLI not installed → installed=false', async () => {
    mockRunStatusProbe.mockResolvedValue(probeResult({ notFound: true }))
    const engine = new TraeAgentEngine(baseConfig)
    expect((await engine.checkLoginStatus()).installed).toBe(false)
  })
})

describe('TraeAgentEngine.listAvailableModels', () => {
  it('oauth → unsupported_mode; apiKey without a key → invalid_input', async () => {
    const engine = new TraeAgentEngine(baseConfig)
    expect((await engine.listAvailableModels({ authMode: 'oauth' })).code).toBe('unsupported_mode')
    expect((await engine.listAvailableModels({ authMode: 'apiKey' })).code).toBe('invalid_input')
  })

  it('apiKey mode injects the token and optional TRAECLI_HOST', async () => {
    mockRunStatusProbe.mockResolvedValue(probeResult({ stdout: 'kimi-k2\n' }))
    const engine = new TraeAgentEngine(baseConfig)
    const result = await engine.listAvailableModels({
      authMode: 'apiKey',
      apiKey: 'trae-lt-1',
      baseUrl: 'https://ent.trae.cn',
    })
    expect(result.models).toEqual(['kimi-k2'])
    const call = mockRunStatusProbe.mock.calls.at(-1)
    expect(call?.[2]?.env).toMatchObject({
      TRAECLI_PERSONAL_ACCESS_TOKEN: 'trae-lt-1',
      TRAECLI_HOST: 'https://ent.trae.cn',
    })
  })

  it('rejects a TRAECLI_HOST that resolves to a private address before spawning', async () => {
    mockDnsLookup.mockResolvedValue([{ address: '10.0.0.8', family: 4 }])
    const engine = new TraeAgentEngine(baseConfig)

    const result = await engine.listAvailableModels({
      authMode: 'apiKey',
      apiKey: 'trae-lt-1',
      baseUrl: 'https://trae-proxy.example.com',
    })

    expect(result.models).toEqual([])
    expect(result.code).toBe('invalid_input')
    expect(result.error).toContain('private or reserved')
    expect(result.error).toContain('TRUSTED_PROVIDER_HOSTS')
    expect(mockRunStatusProbe).not.toHaveBeenCalled()
  })

  it('allows a configured trusted TRAECLI_HOST that resolves to a private address', async () => {
    mockDnsLookup.mockResolvedValue([{ address: '10.0.0.8', family: 4 }])
    mockRunStatusProbe.mockResolvedValue(probeResult({ stdout: 'private-model\n' }))
    const engine = new TraeAgentEngine(baseConfig)

    const result = await engine.listAvailableModels({
      authMode: 'apiKey',
      apiKey: 'trae-lt-1',
      baseUrl: 'https://trusted-provider.example.com',
    })

    expect(result.models).toEqual(['private-model'])
    expect(mockRunStatusProbe).toHaveBeenCalledWith(
      'traecli',
      ['models'],
      expect.objectContaining({
        env: {
          TRAECLI_PERSONAL_ACCESS_TOKEN: 'trae-lt-1',
          TRAECLI_HOST: 'https://trusted-provider.example.com',
        },
      }),
    )
  })

  it('empty output → local_session_not_logged_in (combined guidance: logged out / invalid token / no models configured)', async () => {
    mockRunStatusProbe.mockResolvedValue(probeResult({ stdout: '\n' }))
    const engine = new TraeAgentEngine(baseConfig)
    const result = await engine.listAvailableModels({ authMode: 'localSession' })
    expect(result.code).toBe('local_session_not_logged_in')
  })

  it('notFound → spawn_failed; timedOut → timeout; exit!=0 → cli_failed', async () => {
    const engine = new TraeAgentEngine(baseConfig)
    mockRunStatusProbe.mockResolvedValueOnce(probeResult({ notFound: true }))
    expect((await engine.listAvailableModels({ authMode: 'localSession' })).code).toBe(
      'spawn_failed',
    )
    mockRunStatusProbe.mockResolvedValueOnce(probeResult({ timedOut: true }))
    expect((await engine.listAvailableModels({ authMode: 'localSession' })).code).toBe('timeout')
    mockRunStatusProbe.mockResolvedValueOnce(probeResult({ exitCode: 1, stderr: 'err' }))
    expect((await engine.listAvailableModels({ authMode: 'localSession' })).code).toBe('cli_failed')
  })
})
