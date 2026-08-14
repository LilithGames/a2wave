import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mockSpawn = vi.hoisted(() => vi.fn())
const mockRunStatusProbe = vi.hoisted(() => vi.fn())

vi.mock('../cli-spawn.js', () => ({ spawnCli: mockSpawn }))

vi.mock('node:child_process', () => ({ execFile: vi.fn(), spawn: mockSpawn }))
vi.mock('../login-status-helper.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../login-status-helper.js')>()
  return { ...actual, runStatusProbe: mockRunStatusProbe }
})

import { PiAgentEngine, parsePiModelIds } from '../pi-agent.js'

const MODEL_TABLE = `provider   model                 context  max-out  thinking  images
anthropic  claude-sonnet-4-6    200K     64K      yes       yes
openai     gpt-5.4              1M       128K     yes       yes
anthropic  claude-sonnet-4-6    200K     64K      yes       yes
`

const baseConfig = {
  path: 'pi',
  timeoutMinutes: 5,
  defaultWorkDir: '/tmp',
  agentDir: '/deployment/pi-agent',
}

const tempDirs: string[] = []

async function createPiSession(options: {
  id: string
  cwd: string
  trailingNewline?: boolean
  paddingBytes?: number
}) {
  const runtimeHome = await mkdtemp(join(tmpdir(), 'a2wave-pi-test-'))
  tempDirs.push(runtimeHome)
  const sessionDir = join(runtimeHome, '.pi', 'sessions')
  await mkdir(sessionDir, { recursive: true })
  const sessionPath = join(sessionDir, `2026-08-03T00-00-00-000Z_${options.id}.jsonl`)
  const header = JSON.stringify({
    type: 'session',
    version: 3,
    id: options.id,
    timestamp: '2026-08-03T00:00:00.000Z',
    cwd: options.cwd,
    ...(options.paddingBytes ? { padding: 'x'.repeat(options.paddingBytes) } : {}),
  })
  await writeFile(sessionPath, options.trailingNewline === false ? header : `${header}\n`)
  return { runtimeHome, sessionPath }
}

async function listPiProviderTempDirs(): Promise<string[]> {
  return (await readdir(tmpdir(), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('a2wave-pi-provider-'))
    .map((entry) => join(tmpdir(), entry.name))
    .sort()
}

class MockChildProcess extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  stdin = null
  pid = 55000
  kill = vi.fn()
}

function getExecuteStream(engine: PiAgentEngine) {
  return (
    engine as unknown as {
      executeStreamWithModel: (
        request: Record<string, unknown>,
        model: string,
      ) => Promise<{ output: string; chatId?: string; success: boolean; usage?: unknown }>
    }
  ).executeStreamWithModel.bind(engine)
}

function jsonLine(value: Record<string, unknown>): string {
  return `${JSON.stringify(value)}\n`
}

function finishOk(child: MockChildProcess, sessionId = 'pi-session', text = 'PONG') {
  child.stdout.write(jsonLine({ type: 'session', version: 3, id: sessionId, cwd: '/tmp/ws' }))
  child.stdout.write(
    jsonLine({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: text },
    }),
  )
  child.stdout.write(
    jsonLine({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text }],
        usage: { input: 12, output: 6, reasoning: 2, cacheRead: 4, cacheWrite: 1 },
        stopReason: 'stop',
      },
    }),
  )
  child.stdout.write(jsonLine({ type: 'agent_settled' }))
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

afterEach(async () => {
  vi.clearAllMocks()
  vi.unstubAllEnvs()
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('parsePiModelIds', () => {
  it('returns deduplicated canonical provider/model IDs', async () => {
    expect(parsePiModelIds(MODEL_TABLE)).toEqual(['anthropic/claude-sonnet-4-6', 'openai/gpt-5.4'])
  })

  it('requires the documented table header', async () => {
    expect(parsePiModelIds('No models available. Run /login.')).toEqual([])
    expect(parsePiModelIds('provider model context\nanthropic claude 200K')).toEqual([])
  })
})

describe('PiAgentEngine login and models', () => {
  it('reports a usable local session when configured models are available', async () => {
    mockRunStatusProbe.mockResolvedValue(probeResult({ stdout: MODEL_TABLE }))
    const engine = new PiAgentEngine(baseConfig)

    await expect(engine.checkLoginStatus()).resolves.toMatchObject({
      installed: true,
      loggedIn: true,
      detail: '2 model(s) available',
      method: 'Pi local credentials',
    })
    expect(mockRunStatusProbe).toHaveBeenCalledWith(
      'pi',
      ['--offline', '--list-models'],
      expect.objectContaining({ logTag: 'pi', completeEnv: expect.any(Object) }),
    )
  })

  it('distinguishes no configured models from a CLI failure', async () => {
    mockRunStatusProbe.mockResolvedValue(
      probeResult({ stdout: 'No models available. Configure an API key or run /login.' }),
    )
    const engine = new PiAgentEngine(baseConfig)

    await expect(engine.listAvailableModels({ authMode: 'localSession' })).resolves.toMatchObject({
      models: [],
      code: 'local_session_not_logged_in',
    })
  })

  it('probes Pi built-in OpenAI models with an isolated API key and proxy override', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'deployment-key-must-not-win')
    const before = await listPiProviderTempDirs()
    let modelsConfig: unknown
    mockRunStatusProbe.mockImplementation(
      async (_command: string, _args: string[], options: { completeEnv: NodeJS.ProcessEnv }) => {
        const configDir = options.completeEnv.PI_CODING_AGENT_DIR as string
        modelsConfig = JSON.parse(await readFile(join(configDir, 'models.json'), 'utf8'))
        return probeResult({ stdout: MODEL_TABLE })
      },
    )
    const engine = new PiAgentEngine(baseConfig)

    await expect(
      engine.listAvailableModels({
        authMode: 'apiKey',
        apiKey: 'agent-pi-secret',
        baseUrl: 'https://proxy.example.com/v1',
      }),
    ).resolves.toEqual({ models: ['openai/gpt-5.4'] })

    expect(mockRunStatusProbe).toHaveBeenCalledWith(
      'pi',
      ['--offline', '--list-models', 'openai'],
      expect.objectContaining({
        logTag: 'pi-models',
        completeEnv: expect.objectContaining({
          A2WAVE_PI_PROVIDER_API_KEY: 'agent-pi-secret',
        }),
      }),
    )
    const probeEnv = mockRunStatusProbe.mock.calls[0]?.[2].completeEnv as NodeJS.ProcessEnv
    expect(probeEnv.OPENAI_API_KEY).toBeUndefined()
    expect(modelsConfig).toEqual({
      providers: {
        openai: {
          baseUrl: 'https://proxy.example.com/v1',
          apiKey: '$A2WAVE_PI_PROVIDER_API_KEY',
        },
      },
    })
    expect(await listPiProviderTempDirs()).toEqual(before)
  })

  it('requires an API key before probing Pi API-key models', async () => {
    const engine = new PiAgentEngine(baseConfig)

    await expect(engine.listAvailableModels({ authMode: 'apiKey' })).resolves.toMatchObject({
      models: [],
      code: 'invalid_input',
    })
    expect(mockRunStatusProbe).not.toHaveBeenCalled()
  })

  it('does not probe models in oauth mode', async () => {
    const engine = new PiAgentEngine(baseConfig)

    await expect(engine.listAvailableModels({ authMode: 'oauth' })).resolves.toMatchObject({
      models: [],
      code: 'unsupported_mode',
    })
    expect(mockRunStatusProbe).not.toHaveBeenCalled()
  })

  it('reports a missing CLI and probe timeout', async () => {
    const engine = new PiAgentEngine(baseConfig)
    mockRunStatusProbe.mockResolvedValueOnce(probeResult({ notFound: true }))
    await expect(engine.checkLoginStatus()).resolves.toMatchObject({
      installed: false,
      loggedIn: false,
    })
    mockRunStatusProbe.mockResolvedValueOnce(probeResult({ timedOut: true }))
    await expect(engine.listAvailableModels({ authMode: 'localSession' })).resolves.toMatchObject({
      code: 'timeout',
    })
  })
})

describe('PiAgentEngine execution', () => {
  it('runs JSON mode, returns session and official usage, and keeps the prompt out of logs', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const entries: Array<{ type: string; params?: Record<string, unknown> }> = []
    const engine = new PiAgentEngine(baseConfig)
    const promise = getExecuteStream(engine)(
      {
        taskId: 'task-1',
        workDir: '/tmp/ws',
        prompt: 'TOP SECRET PROMPT',
        onLogEntry: (entry: { type: string; params?: Record<string, unknown> }) =>
          entries.push(entry),
        runtimeContext: {
          env: { HOME: '/runtime/home', A2WAVE_RUN_ID: 'run-1' },
          home: { dir: '/runtime/home' },
          workspace: { dir: '/tmp/ws', type: 'temp' },
          artifacts: { dir: '/tmp/artifacts' },
        },
      },
      'anthropic/claude-sonnet-4-6',
    )
    await new Promise((resolvePromise) => setImmediate(resolvePromise))
    finishOk(child)

    await expect(promise).resolves.toMatchObject({
      success: true,
      output: 'PONG',
      chatId: 'pi-session',
      usage: {
        inputTokens: 12,
        outputTokens: 4,
        reasoningTokens: 2,
        cacheReadTokens: 4,
        cacheWriteTokens: 1,
      },
    })
    const args = lastSpawnArgs()
    expect(args).toEqual(
      expect.arrayContaining([
        '--mode',
        'json',
        '--offline',
        '--no-extensions',
        '--no-skills',
        '--no-approve',
        '--skill',
        join('/tmp/ws', '.pi', 'skills'),
        '--session-dir',
        join('/runtime/home', '.pi', 'sessions'),
        '--model',
        'anthropic/claude-sonnet-4-6',
      ]),
    )
    expect(args.at(-1)).toBe('TOP SECRET PROMPT')
    expect(JSON.stringify(entries.find((entry) => entry.type === 'exec_params'))).not.toContain(
      'TOP SECRET PROMPT',
    )
  })

  it('isolates an Agent API key and proxy URL in an ephemeral provider override', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'deployment-key-must-not-win')
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const entries: Array<{ type: string; params?: Record<string, unknown> }> = []
    const engine = new PiAgentEngine(baseConfig)
    const promise = getExecuteStream(engine)(
      {
        taskId: 'task-api-key-proxy',
        workDir: '/tmp/ws',
        prompt: 'ping',
        agentConfig: {
          authMode: 'apiKey',
          providerApiKey: 'agent-pi-secret',
          providerBaseUrl: 'https://proxy.example.com/v1',
        },
        onLogEntry: (entry: { type: string; params?: Record<string, unknown> }) =>
          entries.push(entry),
        runtimeContext: {
          env: { HOME: '/runtime/home', A2WAVE_RUN_ID: 'run-api-key' },
          home: { dir: '/runtime/home' },
          workspace: { dir: '/tmp/ws', type: 'temp' },
          artifacts: { dir: '/tmp/artifacts' },
        },
      },
      'openai/gpt-5.4',
    )
    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled())

    const env = lastSpawnEnv()
    const configDir = env.PI_CODING_AGENT_DIR
    let modelsConfig: unknown
    let configReadError: unknown
    try {
      modelsConfig = JSON.parse(await readFile(join(configDir as string, 'models.json'), 'utf8'))
    } catch (error) {
      configReadError = error
    }
    const args = lastSpawnArgs()
    finishOk(child)
    await promise

    expect(configReadError).toBeUndefined()
    expect(configDir).not.toBe(resolve('/deployment/pi-agent'))
    expect(modelsConfig).toEqual({
      providers: {
        openai: {
          baseUrl: 'https://proxy.example.com/v1',
          apiKey: '$A2WAVE_PI_PROVIDER_API_KEY',
        },
      },
    })
    expect(env.A2WAVE_PI_PROVIDER_API_KEY).toBe('agent-pi-secret')
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(args).not.toContain('agent-pi-secret')
    expect(JSON.stringify(entries)).not.toContain('agent-pi-secret')
    expect(JSON.stringify(entries)).not.toContain('https://proxy.example.com')
    expect(entries.find((entry) => entry.type === 'exec_params')?.params).toMatchObject({
      authMode: 'apiKey',
      proxyConfigured: true,
    })
    await expect(stat(configDir as string)).rejects.toThrow()
  })

  it('removes the ephemeral provider override after a failed Pi process', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const engine = new PiAgentEngine(baseConfig)
    const promise = getExecuteStream(engine)(
      {
        taskId: 'task-api-key-failure',
        workDir: '/tmp/ws',
        prompt: 'ping',
        agentConfig: { authMode: 'apiKey', providerApiKey: 'agent-key' },
      },
      'openai/gpt-5.4',
    )
    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled())
    const configDir = lastSpawnEnv().PI_CODING_AGENT_DIR as string

    child.stderr.write('proxy unavailable')
    child.emit('close', 1)

    await expect(promise).rejects.toThrow(/proxy unavailable/)
    await expect(stat(configDir)).rejects.toThrow()
  })

  it('rejects incomplete apiKey configuration before spawning Pi', async () => {
    const engine = new PiAgentEngine(baseConfig)

    await expect(
      getExecuteStream(engine)(
        {
          taskId: 'task-api-key-missing',
          workDir: '/tmp/ws',
          prompt: 'ping',
          agentConfig: { authMode: 'apiKey' },
        },
        'openai/gpt-5.4',
      ),
    ).rejects.toThrow(/requires providerApiKey/)
    await expect(
      getExecuteStream(engine)(
        {
          taskId: 'task-openai-provider-required',
          workDir: '/tmp/ws',
          prompt: 'ping',
          agentConfig: { authMode: 'apiKey', providerApiKey: 'agent-key' },
        },
        'anthropic/claude-sonnet-4-6',
      ),
    ).rejects.toThrow(/openai\/<model>/)
    expect(mockSpawn).not.toHaveBeenCalled()
  })

  it('removes the ephemeral provider override when preparation fails before spawn', async () => {
    const before = await listPiProviderTempDirs()
    const engine = new PiAgentEngine(baseConfig)

    await expect(
      getExecuteStream(engine)(
        {
          taskId: 'task-preparation-failure',
          workDir: '/tmp/ws',
          prompt: 'ping',
          agentConfig: { authMode: 'apiKey', providerApiKey: 'agent-key' },
          onLogEntry: () => {
            throw new Error('log sink unavailable')
          },
        },
        'openai/gpt-5.4',
      ),
    ).rejects.toThrow('log sink unavailable')

    expect(await listPiProviderTempDirs()).toEqual(before)
    expect(mockSpawn).not.toHaveBeenCalled()
  })

  it('resumes exact sessions and maps readOnly to Pi built-in tools', async () => {
    const workDir = resolve('/tmp/ws')
    const { runtimeHome } = await createPiSession({ id: 'pi-session-old', cwd: workDir })
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const engine = new PiAgentEngine(baseConfig)
    const promise = getExecuteStream(engine)(
      {
        taskId: 'task-2',
        workDir,
        prompt: 'again',
        chatId: 'pi-session-old',
        agentConfig: { readOnly: true },
        runtimeContext: {
          env: {},
          home: { dir: runtimeHome },
          workspace: { dir: workDir, type: 'temp' },
          artifacts: { dir: join(runtimeHome, 'artifacts') },
        },
      },
      'openai/gpt-5.4',
    )
    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled())
    finishOk(child, 'pi-session-old')
    await promise

    const args = lastSpawnArgs()
    expect(args).toEqual(expect.arrayContaining(['--session-id', 'pi-session-old']))
    expect(args).toEqual(expect.arrayContaining(['--tools', 'read,grep,find,ls']))
  })

  it('resumes a session whose header has no trailing newline', async () => {
    const workDir = resolve('/tmp/ws')
    const { runtimeHome } = await createPiSession({
      id: 'pi-session-no-newline',
      cwd: workDir,
      trailingNewline: false,
    })
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const engine = new PiAgentEngine(baseConfig)

    const promise = getExecuteStream(engine)(
      {
        taskId: 'task-no-newline',
        workDir,
        prompt: 'again',
        chatId: 'pi-session-no-newline',
        runtimeContext: {
          env: {},
          home: { dir: runtimeHome },
          workspace: { dir: workDir, type: 'temp' },
          artifacts: { dir: join(runtimeHome, 'artifacts') },
        },
      },
      'openai/gpt-5.4',
    )
    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled())
    finishOk(child, 'pi-session-no-newline')
    await promise

    expect(lastSpawnArgs()).toEqual(
      expect.arrayContaining(['--session-id', 'pi-session-no-newline']),
    )
  })

  it('resumes a session whose header spans multiple read chunks', async () => {
    const workDir = resolve('/tmp/ws')
    const { runtimeHome } = await createPiSession({
      id: 'pi-session-large-header',
      cwd: workDir,
      paddingBytes: 70 * 1024,
    })
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const engine = new PiAgentEngine(baseConfig)

    const promise = getExecuteStream(engine)(
      {
        taskId: 'task-large-header',
        workDir,
        prompt: 'again',
        chatId: 'pi-session-large-header',
        runtimeContext: {
          env: {},
          home: { dir: runtimeHome },
          workspace: { dir: workDir, type: 'temp' },
          artifacts: { dir: join(runtimeHome, 'artifacts') },
        },
      },
      'openai/gpt-5.4',
    )
    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled())
    finishOk(child, 'pi-session-large-header')
    await promise

    expect(lastSpawnArgs()).toEqual(
      expect.arrayContaining(['--session-id', 'pi-session-large-header']),
    )
  })

  it('forks the previous Pi session when a chat moves to another worktree', async () => {
    const previousWorkDir = resolve('/tmp/old-worktree')
    const nextWorkDir = resolve('/tmp/new-worktree')
    const { runtimeHome, sessionPath } = await createPiSession({
      id: 'pi-session-old',
      cwd: previousWorkDir,
    })
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const engine = new PiAgentEngine(baseConfig)

    const promise = getExecuteStream(engine)(
      {
        taskId: 'task-worktree-change',
        workDir: nextWorkDir,
        prompt: 'continue in the new worktree',
        chatId: 'pi-session-old',
        runtimeContext: {
          env: {},
          home: { dir: runtimeHome },
          workspace: { dir: nextWorkDir, type: 'scm-worktree' },
          artifacts: { dir: join(runtimeHome, 'artifacts') },
        },
      },
      'openai/gpt-5.4',
    )
    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled())
    finishOk(child, 'pi-session-forked')

    await expect(promise).resolves.toMatchObject({ chatId: 'pi-session-forked' })
    expect(lastSpawnArgs()).toEqual(expect.arrayContaining(['--fork', sessionPath]))
    expect(lastSpawnArgs()).not.toContain('--session-id')
  })

  it('starts a fresh Pi session with the existing chat id when persistence is missing', async () => {
    const runtimeHome = await mkdtemp(join(tmpdir(), 'a2wave-pi-test-'))
    tempDirs.push(runtimeHome)
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const engine = new PiAgentEngine(baseConfig)

    const promise = getExecuteStream(engine)(
      {
        taskId: 'task-missing-session',
        workDir: resolve('/tmp/ws'),
        prompt: 'continue the missing chat',
        chatId: 'pi-session-missing',
        runtimeContext: {
          env: {},
          home: { dir: runtimeHome },
          workspace: { dir: resolve('/tmp/ws'), type: 'temp' },
          artifacts: { dir: join(runtimeHome, 'artifacts') },
        },
      },
      'openai/gpt-5.4',
    )
    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled())
    finishOk(child, 'pi-session-missing')

    await expect(promise).resolves.toMatchObject({ chatId: 'pi-session-missing' })
    expect(lastSpawnArgs()).toEqual(expect.arrayContaining(['--session-id', 'pi-session-missing']))
  })

  it('keeps the deployment credential home while isolating runtime cache and sessions', async () => {
    vi.stubEnv('HOME', '/deployment/home')
    vi.stubEnv('XDG_CONFIG_HOME', '/deployment/config')
    vi.stubEnv('OPENAI_API_KEY', 'trusted-openai-key')
    vi.stubEnv('PI_CODING_AGENT_SESSION_DIR', '/deployment/pi-sessions')
    vi.stubEnv('PI_PACKAGE_DIR', '/deployment/pi-package')
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const engine = new PiAgentEngine(baseConfig)
    const promise = getExecuteStream(engine)(
      {
        taskId: 'task-3',
        workDir: '/tmp/ws',
        prompt: 'ping',
        agentConfig: {
          authMode: 'localSession',
          providerApiKey: 'agent-key-must-be-ignored',
          providerBaseUrl: 'https://agent-proxy-must-be-ignored.example',
          agentEnv: {
            OPENAI_API_KEY: 'attacker-key',
            PI_CODING_AGENT_DIR: '/attacker/pi',
            PI_CODING_AGENT_SESSION_DIR: '/attacker/pi-sessions',
            PI_PACKAGE_DIR: '/attacker/pi-package',
            HTTPS_PROXY: 'https://attacker.example',
            SAFE_VAR: 'kept',
          },
        },
        runtimeContext: {
          env: {
            HOME: '/runtime/home',
            XDG_CONFIG_HOME: '/runtime/config',
            XDG_CACHE_HOME: '/runtime/cache',
            TMPDIR: '/runtime/tmp',
            A2WAVE_RUN_ID: 'run-3',
          },
          home: { dir: '/runtime/home' },
          workspace: { dir: '/tmp/ws', type: 'temp' },
          artifacts: { dir: '/tmp/artifacts' },
        },
      },
      // A migrated legacy binding may retain a non-OpenAI model and stale
      // Agent credentials. localSession must continue to ignore both fields.
      'anthropic/claude-sonnet-4-6',
    )
    await new Promise((resolvePromise) => setImmediate(resolvePromise))
    finishOk(child)
    await promise

    const env = lastSpawnEnv()
    expect(env.HOME).toBe('/deployment/home')
    expect(env.XDG_CONFIG_HOME).toBe('/deployment/config')
    expect(env.XDG_CACHE_HOME).toBe('/runtime/cache')
    expect(env.TMPDIR).toBe('/runtime/tmp')
    expect(env.A2WAVE_RUN_ID).toBe('run-3')
    expect(env.PI_CODING_AGENT_DIR).toBe(resolve('/deployment/pi-agent'))
    expect(env.PI_CODING_AGENT_SESSION_DIR).toBe('/deployment/pi-sessions')
    expect(env.PI_PACKAGE_DIR).toBe('/deployment/pi-package')
    expect(env.OPENAI_API_KEY).toBe('trusted-openai-key')
    expect(env.HTTPS_PROXY).not.toBe('https://attacker.example')
    expect(env.PI_OFFLINE).toBe('1')
    expect(env.PI_SKIP_VERSION_CHECK).toBe('1')
    expect(env.PI_TELEMETRY).toBe('0')
    expect(env.SAFE_VAR).toBe('kept')
    expect(lastSpawnArgs()).toEqual(
      expect.arrayContaining(['--session-dir', join('/runtime/home', '.pi', 'sessions')]),
    )
  })

  it('rejects an exit-0 stream without agent_settled', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const engine = new PiAgentEngine(baseConfig)
    const promise = getExecuteStream(engine)(
      { taskId: 'task-4', workDir: '/tmp/ws', prompt: 'ping' },
      'openai/gpt-5.4',
    )
    await new Promise((resolvePromise) => setImmediate(resolvePromise))
    child.stdout.write(
      jsonLine({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'partial' }],
          stopReason: 'stop',
        },
      }),
    )
    child.emit('close', 0)

    await expect(promise).rejects.toThrow(/before emitting agent_settled/)
  })

  it('rejects a final assistant error even when Pi exits 0', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const engine = new PiAgentEngine(baseConfig)
    const promise = getExecuteStream(engine)(
      { taskId: 'task-5', workDir: '/tmp/ws', prompt: 'ping' },
      'openai/gpt-5.4',
    )
    await new Promise((resolvePromise) => setImmediate(resolvePromise))
    child.stdout.write(
      jsonLine({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [],
          usage: { input: 5, output: 0, cacheRead: 0, cacheWrite: 0 },
          stopReason: 'error',
          errorMessage: 'No API key found',
        },
      }),
    )
    child.stdout.write(jsonLine({ type: 'agent_settled' }))
    child.emit('close', 0)

    await expect(promise).rejects.toThrow(/No API key found/)
  })

  it('preserves the last retry error when recovery produces no assistant output', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const engine = new PiAgentEngine(baseConfig)
    const promise = getExecuteStream(engine)(
      { taskId: 'task-empty-retry', workDir: '/tmp/ws', prompt: 'ping' },
      'openai/gpt-5.4',
    )
    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled())
    child.stdout.write(
      jsonLine({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [],
          stopReason: 'error',
          errorMessage: 'No API key found',
        },
      }),
    )
    child.stdout.write(
      jsonLine({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 10 }),
    )
    child.stdout.write(
      jsonLine({
        type: 'message_end',
        message: { role: 'assistant', content: [], stopReason: 'stop' },
      }),
    )
    child.stdout.write(jsonLine({ type: 'auto_retry_end', success: true, attempt: 1 }))
    child.stdout.write(jsonLine({ type: 'agent_settled' }))
    child.emit('close', 0)

    await expect(promise).rejects.toThrow(/No API key found/)
  })
})
