import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mockSpawn = vi.hoisted(() => vi.fn())
const mockRunStatusProbe = vi.hoisted(() => vi.fn())

vi.mock('../cli-spawn.js', () => ({ spawnCli: mockSpawn }))

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
  spawn: mockSpawn,
}))
vi.mock('../login-status-helper.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../login-status-helper.js')>()
  return { ...actual, runStatusProbe: mockRunStatusProbe }
})

import { KimiAgentEngine, parseKimiModelAliases } from '../kimi-agent.js'

const baseConfig = {
  path: 'kimi',
  timeoutMinutes: 5,
  defaultWorkDir: '/tmp',
}

class MockChildProcess extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  stdin = null
  pid = 44000
  kill = vi.fn()
}

type StreamRequest = Record<string, unknown>

function getExecuteStream(engine: KimiAgentEngine) {
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

/** Minimal success replay (row shape observed with kimi 0.30.0). */
function finishOk(child: MockChildProcess, sessionId = 'session_k1', text = 'PONG') {
  child.stdout.write(line({ role: 'assistant', content: text }))
  child.stdout.write(line({ role: 'meta', type: 'session.resume_hint', session_id: sessionId }))
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

/** `kimi provider list --json` payload for a signed-in host. */
const LOGGED_IN_JSON = JSON.stringify({
  providers: { 'managed:kimi-code': { type: 'kimi' } },
  models: {
    'kimi-code/k3': { provider: 'managed:kimi-code' },
    'kimi-code/kimi-for-coding': { provider: 'managed:kimi-code' },
  },
})

afterEach(() => vi.clearAllMocks())

describe('parseKimiModelAliases', () => {
  it('returns the model alias keys', async () => {
    expect(parseKimiModelAliases(LOGGED_IN_JSON)).toEqual([
      'kimi-code/k3',
      'kimi-code/kimi-for-coding',
    ])
  })

  it('returns an empty list for the signed-out payload', async () => {
    expect(parseKimiModelAliases('{"providers":{},"models":{}}')).toEqual([])
  })

  it('returns an empty list when `models` is an array rather than a map', async () => {
    // The aliases are object KEYS; an array shape carries no keys to bind, so
    // it must not be read as "models available".
    expect(parseKimiModelAliases('{"models":["a","b"]}')).toEqual([])
  })

  it('returns an empty list for malformed or non-object JSON', async () => {
    expect(parseKimiModelAliases('not json')).toEqual([])
    expect(parseKimiModelAliases('[1,2]')).toEqual([])
    expect(parseKimiModelAliases('{"models":null}')).toEqual([])
    // An array-shaped `models` field is not the documented object-of-aliases
    // shape and must not be treated as one.
    expect(parseKimiModelAliases('{"models":["kimi-code/k3"]}')).toEqual([])
  })
})

describe('KimiAgentEngine.checkLoginStatus', () => {
  it('reports logged in when the managed provider exposes models', async () => {
    mockRunStatusProbe.mockResolvedValue(probeResult({ stdout: LOGGED_IN_JSON }))
    const engine = new KimiAgentEngine(baseConfig)

    const status = await engine.checkLoginStatus()

    expect(mockRunStatusProbe).toHaveBeenCalledWith(
      'kimi',
      ['provider', 'list', '--json'],
      expect.objectContaining({ logTag: 'kimi' }),
    )
    expect(status).toMatchObject({
      installed: true,
      loggedIn: true,
      detail: '2 model(s) available',
      method: 'oauth (device code)',
    })
  })

  it('reports logged out when the payload carries no models', async () => {
    mockRunStatusProbe.mockResolvedValue(probeResult({ stdout: '{"providers":{},"models":{}}' }))
    const engine = new KimiAgentEngine(baseConfig)

    const status = await engine.checkLoginStatus()

    expect(status.loggedIn).toBe(false)
    expect(status.installed).toBe(true)
    expect(status.error).toMatch(/kimi login/)
  })

  it('reports not installed when the CLI is missing', async () => {
    mockRunStatusProbe.mockResolvedValue(probeResult({ notFound: true }))
    const engine = new KimiAgentEngine(baseConfig)

    const status = await engine.checkLoginStatus()

    expect(status).toMatchObject({ installed: false, loggedIn: false })
    expect(status.error).toMatch(/not found in PATH/)
  })

  it('reports logged out on a non-zero exit even when stdout lists models', async () => {
    // A CLI that prints a stale model list and then exits 1 must not be
    // reported as logged in.
    mockRunStatusProbe.mockResolvedValue(
      probeResult({ exitCode: 1, stdout: LOGGED_IN_JSON, stderr: 'auth expired' }),
    )
    const engine = new KimiAgentEngine(baseConfig)

    const status = await engine.checkLoginStatus()

    expect(status).toMatchObject({ installed: true, loggedIn: false, error: 'auth expired' })
  })

  it('probes with the execution env so env-provider models cannot leak in', async () => {
    // Regression for the probe/execution env split: execution clears the
    // KIMI_MODEL_* family, from which the CLI synthesizes an in-memory env
    // provider. A probe inheriting them would report models (and a login
    // state) no real run can use, so the probe must run under the same
    // constructor — stripping KIMI_MODEL_* while preserving the host HOME
    // the OAuth credential store resolves through.
    vi.stubEnv('KIMI_MODEL_NAME', 'env-injected-model')
    try {
      mockRunStatusProbe.mockResolvedValue(probeResult({ stdout: LOGGED_IN_JSON }))
      const engine = new KimiAgentEngine(baseConfig)

      await engine.checkLoginStatus()

      const options = mockRunStatusProbe.mock.calls.at(-1)?.[2] as {
        completeEnv: NodeJS.ProcessEnv
      }
      expect(options.completeEnv).toBeDefined()
      expect(options.completeEnv.KIMI_MODEL_NAME).toBeUndefined()
      expect(options.completeEnv.HOME).toBe(process.env.HOME)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('does not claim a login when the probe exits non-zero', async () => {
    mockRunStatusProbe.mockResolvedValue(probeResult({ exitCode: 1, stderr: 'boom' }))
    const engine = new KimiAgentEngine(baseConfig)

    const status = await engine.checkLoginStatus()

    expect(status).toMatchObject({ installed: true, loggedIn: false })
  })

  it('surfaces a probe timeout without claiming a login state', async () => {
    mockRunStatusProbe.mockResolvedValue(probeResult({ timedOut: true }))
    const engine = new KimiAgentEngine(baseConfig)

    const status = await engine.checkLoginStatus()

    expect(status).toMatchObject({ installed: true, loggedIn: false })
    expect(status.error).toMatch(/timed out/)
  })
})

describe('KimiAgentEngine.listAvailableModels', () => {
  it('lists the host account model aliases in localSession mode', async () => {
    mockRunStatusProbe.mockResolvedValue(probeResult({ stdout: LOGGED_IN_JSON }))
    const engine = new KimiAgentEngine(baseConfig)

    const result = await engine.listAvailableModels({ authMode: 'localSession' })

    expect(result.models).toEqual(['kimi-code/k3', 'kimi-code/kimi-for-coding'])
    expect(result.error).toBeUndefined()
  })

  it.each(['apiKey', 'oauth'] as const)('rejects %s mode as unsupported', async (authMode) => {
    const engine = new KimiAgentEngine(baseConfig)

    const result = await engine.listAvailableModels({ authMode, apiKey: 'k' })

    expect(result).toMatchObject({ models: [], code: 'unsupported_mode' })
    // No credential channel exists, so the CLI must not even be spawned.
    expect(mockRunStatusProbe).not.toHaveBeenCalled()
  })

  it('flags a signed-out host distinctly from a CLI failure', async () => {
    mockRunStatusProbe.mockResolvedValue(probeResult({ stdout: '{"providers":{},"models":{}}' }))
    const engine = new KimiAgentEngine(baseConfig)

    const result = await engine.listAvailableModels({ authMode: 'localSession' })

    expect(result).toMatchObject({ models: [], code: 'local_session_not_logged_in' })
  })

  it('reports a non-zero exit as a CLI failure', async () => {
    mockRunStatusProbe.mockResolvedValue(probeResult({ exitCode: 1, stderr: 'boom' }))
    const engine = new KimiAgentEngine(baseConfig)

    const result = await engine.listAvailableModels({ authMode: 'localSession' })

    expect(result).toMatchObject({ models: [], code: 'cli_failed', error: 'boom' })
  })
})

describe('KimiAgentEngine probe/execution env parity', () => {
  const ORIGINAL = { ...process.env }
  afterEach(() => {
    process.env = { ...ORIGINAL }
  })

  it.each([
    ['checkLoginStatus', (e: KimiAgentEngine) => e.checkLoginStatus()],
    [
      'listAvailableModels',
      (e: KimiAgentEngine) => e.listAvailableModels({ authMode: 'localSession' }),
    ],
  ] as const)('runs %s under the same stripped env as execution', async (_name, invoke) => {
    // A host that leaks the KIMI_MODEL_* family makes `provider list --json`
    // synthesize an in-memory provider (verified on 0.30.0: it reports
    // `__kimi_env_model__`). Execution strips those vars, so a model bound from
    // an unstripped probe cannot exist at run time — the Provider reads healthy
    // and every run fails with "No model configured". Probe and execution must
    // therefore see the same env.
    process.env.KIMI_MODEL_NAME = 'phantom'
    process.env.KIMI_MODEL_API_KEY = 'sk-phantom'
    process.env.KIMI_CODE_BASE_URL = 'https://redirected.example.com'
    mockRunStatusProbe.mockResolvedValue(probeResult({ stdout: LOGGED_IN_JSON }))
    const engine = new KimiAgentEngine(baseConfig)

    await invoke(engine)

    const options = mockRunStatusProbe.mock.calls.at(-1)?.[2] as {
      completeEnv?: NodeJS.ProcessEnv
    }
    expect(options?.completeEnv, 'probe must pass an explicit env, not inherit').toBeDefined()
    expect(options?.completeEnv?.KIMI_MODEL_NAME).toBeUndefined()
    expect(options?.completeEnv?.KIMI_MODEL_API_KEY).toBeUndefined()
    expect(options?.completeEnv?.KIMI_CODE_BASE_URL).toBeUndefined()
    // The operator's credential-store pointer must still survive.
    expect(options?.completeEnv?.HOME).toBe(process.env.HOME)
  })
})

describe('KimiAgentEngine.executeStreamWithModel', () => {
  it('runs headless stream-json and returns the assistant output plus session id', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const engine = new KimiAgentEngine(baseConfig)
    const promise = getExecuteStream(engine)(
      { taskId: 'task_1', workDir: '/tmp/ws', prompt: 'ping' },
      'kimi-code/k3',
    )
    await new Promise((resolve) => setImmediate(resolve))
    finishOk(child)

    const result = await promise

    expect(result).toMatchObject({
      success: true,
      output: 'PONG',
      chatId: 'session_k1',
    })
    expect(lastSpawnArgs()).toEqual([
      '-p',
      'ping',
      '--output-format',
      'stream-json',
      '-m',
      'kimi-code/k3',
    ])
  })

  it('resumes a session with -r', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const engine = new KimiAgentEngine(baseConfig)
    const promise = getExecuteStream(engine)(
      { taskId: 'task_2', workDir: '/tmp/ws', prompt: 'again', chatId: 'session_prev' },
      'kimi-code/k3',
    )
    await new Promise((resolve) => setImmediate(resolve))
    finishOk(child, 'session_prev')
    await promise

    const args = lastSpawnArgs()
    expect(args).toContain('-r')
    expect(args[args.indexOf('-r') + 1]).toBe('session_prev')
  })

  it('never passes --yolo/--auto/--plan, which -p rejects', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const engine = new KimiAgentEngine(baseConfig)
    const promise = getExecuteStream(engine)(
      {
        taskId: 'task_3',
        workDir: '/tmp/ws',
        prompt: 'ping',
        agentConfig: { force: true, readOnly: true, approveMcps: true },
      },
      'kimi-code/k3',
    )
    await new Promise((resolve) => setImmediate(resolve))
    finishOk(child)
    await promise

    const args = lastSpawnArgs()
    expect(args).not.toContain('--yolo')
    expect(args).not.toContain('--auto')
    expect(args).not.toContain('--plan')
  })

  it('still runs on localSession when the Agent row carries a stale apiKey mode', async () => {
    // `authMode` defaults to 'apiKey' platform-wide, so an Agent created without
    // an explicit mode reaches this engine with a value Kimi cannot honour.
    // Execution must normalize to localSession rather than fail or try to inject
    // a credential the CLI would never read from the environment.
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const engine = new KimiAgentEngine(baseConfig)
    const entries: Array<{ type: string; params?: Record<string, unknown> }> = []
    const promise = getExecuteStream(engine)(
      {
        taskId: 'task_stale',
        workDir: '/tmp/ws',
        prompt: 'ping',
        agentConfig: { authMode: 'apiKey', providerApiKey: 'sk-should-be-ignored' },
        onLogEntry: (entry: { type: string }) => entries.push(entry),
      },
      'kimi-code/k3',
    )
    await new Promise((resolve) => setImmediate(resolve))
    finishOk(child)

    await expect(promise).resolves.toMatchObject({ success: true, output: 'PONG' })
    const execParams = entries.find((entry) => entry.type === 'exec_params')
    expect(execParams?.params).toMatchObject({ authMode: 'localSession' })
    // The stale key must never reach the subprocess or the audit log.
    expect(JSON.stringify(execParams?.params)).not.toContain('sk-should-be-ignored')
    expect(lastSpawnEnv().KIMI_API_KEY).toBeUndefined()
  })

  it('fails the run when the CLI exits non-zero, surfacing stderr', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const engine = new KimiAgentEngine(baseConfig)
    const promise = getExecuteStream(engine)(
      { taskId: 'task_4', workDir: '/tmp/ws', prompt: 'ping' },
      'kimi-code/k3',
    )
    await new Promise((resolve) => setImmediate(resolve))
    // A signed-out host: exits 1 with the guidance on stderr and no stdout rows.
    child.stderr.write('error: failed to run prompt: No model configured.\n')
    child.emit('close', 1)

    await expect(promise).rejects.toThrow(/No model configured/)
  })

  it('fails the run on an in-stream error row even when the process exits 0', async () => {
    // End-to-end wiring of the parser's resultIsError into settle: the error
    // text from the row wins over stderr and the exit code.
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const engine = new KimiAgentEngine(baseConfig)
    const promise = getExecuteStream(engine)(
      { taskId: 'task_err_row', workDir: '/tmp/ws', prompt: 'ping' },
      'kimi-code/k3',
    )
    await new Promise((resolve) => setImmediate(resolve))
    child.stdout.write(line({ role: 'assistant', content: 'partial answer' }))
    child.stdout.write(line({ role: 'error', content: 'model overloaded' }))
    child.emit('close', 0)

    await expect(promise).rejects.toThrow(/model overloaded/)
  })

  it('falls back to exit code 1 when the process closes without one', async () => {
    // A process killed (e.g. by the timeout) can close with a null exit code;
    // settle must still fail the run instead of crashing on the verdict.
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const engine = new KimiAgentEngine(baseConfig)
    const promise = getExecuteStream(engine)(
      { taskId: 'task_null_exit', workDir: '/tmp/ws', prompt: 'ping' },
      'kimi-code/k3',
    )
    await new Promise((resolve) => setImmediate(resolve))
    child.stdout.write(line({ role: 'assistant', content: 'partial answer' }))
    child.emit('close', null)

    await expect(promise).rejects.toThrow(/Execution failed/)
  })

  it('preserves the host HOME so the OAuth credential store resolves', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const engine = new KimiAgentEngine(baseConfig)
    const promise = getExecuteStream(engine)(
      {
        taskId: 'task_5',
        workDir: '/tmp/ws',
        prompt: 'ping',
        runtimeContext: {
          agentId: 'agt_1',
          runId: 'run_1',
          workspace: { dir: '/tmp/ws', type: 'temp', cleanup: 'after-run' },
          home: {
            dir: '/runtime/home',
            cacheDir: '/runtime/home/.cache',
            configDir: '/runtime/home/.config',
            tmpDir: '/runtime/home/tmp',
            claudeDir: '/runtime/home/.claude',
            codexHomeDir: '/runtime/home/.codex',
          },
          artifacts: { dir: '/tmp/artifacts' },
          env: { HOME: '/runtime/home', A2WAVE_RUN_ID: 'run_1' },
        },
      },
      'kimi-code/k3',
    )
    await new Promise((resolve) => setImmediate(resolve))
    finishOk(child)
    await promise

    const env = lastSpawnEnv()
    // The isolated runtime HOME must not override the host login state — and
    // asserting only `not.toBe('/runtime/home')` would also pass if HOME were
    // deleted outright, which would sever the credential store just as badly.
    expect(env.HOME).toBe(process.env.HOME)
    // Same for an operator-relocated data root.
    expect(env.XDG_CONFIG_HOME).not.toBe('/runtime/home/.config')
    // Non-credential runtime env still passes through.
    expect(env.A2WAVE_RUN_ID).toBe('run_1')
  })

  it('strips credential-class env vars supplied through agentEnv', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const engine = new KimiAgentEngine(baseConfig)
    const promise = getExecuteStream(engine)(
      {
        taskId: 'task_6',
        workDir: '/tmp/ws',
        prompt: 'ping',
        agentConfig: {
          agentEnv: {
            KIMI_CODE_HOME: '/attacker/home',
            KIMI_CODE_BASE_URL: 'https://evil.example.com',
            KIMI_MODEL_NAME: 'pwned',
            KIMI_MODEL_API_KEY: 'sk-evil',
            SAFE_VAR: 'kept',
          },
        },
      },
      'kimi-code/k3',
    )
    await new Promise((resolve) => setImmediate(resolve))
    finishOk(child)
    await promise

    const env = lastSpawnEnv()
    // Data-root redirects are blocked from agentEnv, but the operator's own
    // value (absent here) is deliberately NOT cleared from the inherited env.
    expect(env.KIMI_CODE_HOME).toBe(process.env.KIMI_CODE_HOME)
    expect(env.KIMI_CODE_HOME).not.toBe('/attacker/home')
    expect(env.HOME).toBe(process.env.HOME)
    expect(env.KIMI_CODE_BASE_URL).toBeUndefined()
    expect(env.KIMI_MODEL_NAME).toBeUndefined()
    expect(env.KIMI_MODEL_API_KEY).toBeUndefined()
    expect(env.SAFE_VAR).toBe('kept')
  })

  it('keeps the operator KIMI_CODE_HOME while blocking an agentEnv redirect', async () => {
    // `KIMI_CODE_HOME` is the load-bearing member of AGENT_ENV_ONLY_KIMI_NAMES:
    // it is the only one this list alone protects. (`HOME` is redundant —
    // sanitizeAgentRuntimeEnv already strips it from agentEnv and
    // omitRuntimeKeys from runtimeEnv — so it is kept as belt-and-braces, and a
    // test asserting only HOME would pass even with the list emptied.)
    const savedCodeHome = process.env.KIMI_CODE_HOME
    process.env.KIMI_CODE_HOME = '/operator/kimi'
    try {
      const child = new MockChildProcess()
      mockSpawn.mockReturnValue(child)
      const engine = new KimiAgentEngine(baseConfig)
      const promise = getExecuteStream(engine)(
        {
          taskId: 'task_home_attack',
          workDir: '/tmp/ws',
          prompt: 'ping',
          agentConfig: {
            agentEnv: { KIMI_CODE_HOME: '/attacker/kimi', HOME: '/attacker/home' },
          },
        },
        'kimi-code/k3',
      )
      await new Promise((resolve) => setImmediate(resolve))
      finishOk(child)
      await promise

      const env = lastSpawnEnv()
      expect(env.KIMI_CODE_HOME).toBe('/operator/kimi')
      expect(env.HOME).toBe(process.env.HOME)
    } finally {
      if (savedCodeHome === undefined) delete process.env.KIMI_CODE_HOME
      else process.env.KIMI_CODE_HOME = savedCodeHome
    }
  })

  it('fails an exit-0 run that produced no assistant output', async () => {
    // There is no `result` row to confirm completion, so exit 0 alone is not
    // proof of success: a run that wrote only to stderr would otherwise be
    // recorded as a successful run with an empty answer.
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const engine = new KimiAgentEngine(baseConfig)
    const promise = getExecuteStream(engine)(
      { taskId: 'task_empty', workDir: '/tmp/ws', prompt: 'ping' },
      'kimi-code/k3',
    )
    await new Promise((resolve) => setImmediate(resolve))
    child.stderr.write('some thinking that never became an answer\n')
    child.emit('close', 0)

    await expect(promise).rejects.toThrow(/without producing any output/)
  })

  it('samples the END of stderr so the real failure survives truncation', async () => {
    // Two opposing ends: the runner keeps the LAST 64KB of stderr
    // (appendBoundedTail), and Kimi writes its actual error LAST — while
    // everything before it is thinking / tool-progress prose. Sampling the head
    // would yield a clean-but-useless 300 chars of narration and drop the
    // cause, which also blinds classifyOAuthExecutionError on any run whose
    // stderr exceeds the sample (i.e. every run that did work before failing).
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const engine = new KimiAgentEngine(baseConfig)
    const promise = getExecuteStream(engine)(
      { taskId: 'task_noise', workDir: '/tmp/ws', prompt: 'ping' },
      'kimi-code/k3',
    )
    await new Promise((resolve) => setImmediate(resolve))
    // A unique marker at the very START, then prose long enough to push it out
    // of a 300-char window (the prose mentions "rate limit" so a head sample
    // would also mis-classify), then the genuine cause on the final line.
    child.stderr.write('HEAD_ONLY_MARKER ')
    child.stderr.write(`${'thinking about rate limit handling '.repeat(400)}\n`)
    child.stderr.write('error: failed to run prompt: No model configured.\n')
    child.emit('close', 1)

    const error = await promise.then(
      () => null,
      (e: Error) => e,
    )
    const message = (error as Error).message
    // Bounded, so runs.error cannot grow to the 64KB tail.
    expect(message.length).toBeLessThan(1000)
    // The cause survives...
    expect(message).toContain('No model configured')
    // ...and the head of the stream does not (this is precisely what
    // distinguishes tail-sampling from head-sampling).
    expect(message).not.toContain('HEAD_ONLY_MARKER')
  })

  it('fails the run when the stream carries an error row, preferring its text', async () => {
    // Engine-side wiring for the parser's forward-compat error guard: the
    // parser sets resultIsError, and settle must reject the run with that text
    // rather than the exit code (the CLI can exit 0 after emitting one).
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const engine = new KimiAgentEngine(baseConfig)
    const promise = getExecuteStream(engine)(
      { taskId: 'task_errrow', workDir: '/tmp/ws', prompt: 'ping' },
      'kimi-code/k3',
    )
    await new Promise((resolve) => setImmediate(resolve))
    child.stdout.write(line({ role: 'assistant', content: 'partial' }))
    child.stdout.write(line({ role: 'error', content: 'upstream model overloaded' }))
    child.emit('close', 0)

    await expect(promise).rejects.toThrow('upstream model overloaded')
  })

  it('logs exec params without the prompt plaintext', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const engine = new KimiAgentEngine(baseConfig)
    const entries: Array<{ type: string; params?: Record<string, unknown> }> = []
    const promise = getExecuteStream(engine)(
      {
        taskId: 'task_7',
        workDir: '/tmp/ws',
        prompt: 'super secret prompt',
        onLogEntry: (entry: { type: string }) => entries.push(entry),
      },
      'kimi-code/k3',
    )
    await new Promise((resolve) => setImmediate(resolve))
    finishOk(child)
    await promise

    const execParams = entries.find((entry) => entry.type === 'exec_params')
    expect(execParams).toBeDefined()
    expect(JSON.stringify(execParams?.params)).not.toContain('super secret prompt')
  })
})
