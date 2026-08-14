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

import { stripPromptArg } from '../cli-engine-base.js'
import { QoderAgentEngine } from '../qoder-agent.js'

const baseConfig = {
  path: 'qodercli',
  apiKey: '',
  timeoutMinutes: 5,
  force: false,
  approveMcps: true,
  defaultWorkDir: '/tmp',
}

class MockChildProcess extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  stdin = null
  pid = 32000
  kill = vi.fn()
}

type StreamRequest = Record<string, unknown>

function getExecuteStream(engine: QoderAgentEngine) {
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

/** Minimal success replay (event shape observed with qodercli 1.0.48): init → assistant → result → close 0 */
function finishOk(child: MockChildProcess, sessionId = 'ses_q1', text = 'PONG') {
  child.stdout.write(line({ type: 'system', subtype: 'init', session_id: sessionId }))
  child.stdout.write(
    line({
      type: 'assistant',
      message: { content: [{ type: 'text', text }] },
      session_id: sessionId,
    }),
  )
  child.stdout.write(
    line({ type: 'result', subtype: 'success', is_error: false, session_id: sessionId }),
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

describe('QoderAgentEngine args', () => {
  it('basic invocation: -p <prompt> --output-format stream-json -m <model>; approveMcps allows mcp__*', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const engine = new QoderAgentEngine(baseConfig)
    const p = getExecuteStream(engine)(
      { taskId: 't', workDir: '/tmp/w', prompt: 'hi', agentConfig: {} },
      'ultimate',
    )
    finishOk(child)
    await p
    const args = lastSpawnArgs()
    expect(args.slice(0, 2)).toEqual(['-p', 'hi'])
    expect(args).toEqual(expect.arrayContaining(['--output-format', 'stream-json']))
    expect(args).toEqual(expect.arrayContaining(['-m', 'ultimate']))
    expect(args).toEqual(expect.arrayContaining(['--allowed-tools', 'mcp__*']))
    expect(args).not.toContain('--dangerously-skip-permissions')
  })

  it('force=true appends --dangerously-skip-permissions; chatId is passed via --resume', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const engine = new QoderAgentEngine({ ...baseConfig, force: true })
    const p = getExecuteStream(engine)(
      { taskId: 't', workDir: '/tmp', prompt: 'hi', chatId: 'ses_prev', agentConfig: {} },
      'auto',
    )
    finishOk(child)
    await p
    const args = lastSpawnArgs()
    expect(args).toContain('--dangerously-skip-permissions')
    expect(args).toEqual(expect.arrayContaining(['--resume', 'ses_prev']))
  })

  it('readOnly uses --permission-mode plan', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const engine = new QoderAgentEngine(baseConfig)
    const p = getExecuteStream(engine)(
      { taskId: 't', workDir: '/tmp', prompt: 'hi', agentConfig: { readOnly: true } },
      'auto',
    )
    finishOk(child)
    await p
    expect(lastSpawnArgs()).toEqual(expect.arrayContaining(['--permission-mode', 'plan']))
  })

  it('stripPromptArg strips -p and the prompt plaintext', async () => {
    expect(stripPromptArg(['-p', 'secret prompt', '--output-format', 'stream-json'])).toEqual([
      '--output-format',
      'stream-json',
    ])
  })
})

// ============================================================
// env (credential matrix)
// ============================================================

describe('QoderAgentEngine env', () => {
  it('apiKey mode injects QODER_PERSONAL_ACCESS_TOKEN (per-agent takes precedence)', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const engine = new QoderAgentEngine({ ...baseConfig, apiKey: 'deploy-pat' })
    const p = getExecuteStream(engine)(
      {
        taskId: 't',
        workDir: '/tmp',
        prompt: 'hi',
        agentConfig: { authMode: 'apiKey', providerApiKey: 'agent-pat' },
      },
      'auto',
    )
    finishOk(child)
    await p
    expect(lastSpawnEnv().QODER_PERSONAL_ACCESS_TOKEN).toBe('agent-pat')
  })

  it('localSession mode unsets the PAT and does not override the host HOME', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    process.env.QODER_PERSONAL_ACCESS_TOKEN = 'leaky'
    try {
      const engine = new QoderAgentEngine(baseConfig)
      const p = getExecuteStream(engine)(
        {
          taskId: 't',
          workDir: '/tmp',
          prompt: 'hi',
          agentConfig: { authMode: 'localSession' },
          runtimeContext: {
            env: { HOME: '/isolated/home', A2WAVE_RUN_ID: 'run_1' },
            home: { dir: '/isolated/home' },
            workspace: { dir: '/tmp', type: 'temp' },
            artifacts: { dir: '/tmp/a' },
          },
        },
        'auto',
      )
      finishOk(child)
      await p
      const env = lastSpawnEnv()
      expect(env.QODER_PERSONAL_ACCESS_TOKEN).toBeUndefined()
      expect(env.HOME).not.toBe('/isolated/home')
      expect(env.A2WAVE_RUN_ID).toBe('run_1')
    } finally {
      delete process.env.QODER_PERSONAL_ACCESS_TOKEN
    }
  })

  it('agentEnv must not carry credential env vars to override the isolation result', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const engine = new QoderAgentEngine({ ...baseConfig, apiKey: 'deploy-pat' })
    const p = getExecuteStream(engine)(
      {
        taskId: 't',
        workDir: '/tmp',
        prompt: 'hi',
        agentConfig: {
          authMode: 'apiKey',
          agentEnv: { QODER_PERSONAL_ACCESS_TOKEN: 'evil', MY_VAR: 'ok' },
        },
      },
      'auto',
    )
    finishOk(child)
    await p
    const env = lastSpawnEnv()
    expect(env.QODER_PERSONAL_ACCESS_TOKEN).toBe('deploy-pat')
    expect(env.MY_VAR).toBe('ok')
  })
})

// ============================================================
// close handling
// ============================================================

describe('QoderAgentEngine stream close handling', () => {
  it('success: resolves with the output and session_id as chatId', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const engine = new QoderAgentEngine(baseConfig)
    const p = getExecuteStream(engine)(
      { taskId: 't', workDir: '/tmp', prompt: 'hi', agentConfig: {} },
      'auto',
    )
    finishOk(child, 'ses_new', 'PONG')
    const result = await p
    expect(result.success).toBe(true)
    expect(result.output).toBe('PONG')
    expect(result.chatId).toBe('ses_new')
  })

  it('does not report placeholder usage from Qoder credit-based billing', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const engine = new QoderAgentEngine(baseConfig)
    const onLogEntry = vi.fn<(entry: { type: string; [k: string]: unknown }) => void>()
    const p = getExecuteStream(engine)(
      { taskId: 't', workDir: '/tmp', prompt: 'hi', onLogEntry, agentConfig: {} },
      'auto',
    )
    child.stdout.write(line({ type: 'system', subtype: 'init', session_id: 's' }))
    // Qoder CLI emits placeholder usage, which must be ignored even if non-zero.
    child.stdout.write(
      line({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'PONG',
        usage: { input_tokens: 12, output_tokens: 34, cache_read_input_tokens: 56 },
      }),
    )
    child.emit('close', 0)
    const result = await p
    // No usage reaches ExecuteResult, so persistence retains the untracked NULL sentinel.
    expect((result as { usage?: unknown }).usage).toBeUndefined()
    // The result log entry must omit usage as well.
    const resultEntry = onLogEntry.mock.calls.map((c) => c[0]).find((e) => e.type === 'result')
    expect(resultEntry).toBeDefined()
    expect(resultEntry).not.toHaveProperty('usage')
  })

  it('result is_error=true rejects even on exit 0 (errors[] text surfaced)', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const engine = new QoderAgentEngine(baseConfig)
    const p = getExecuteStream(engine)(
      { taskId: 't', workDir: '/tmp', prompt: 'hi', agentConfig: {} },
      'auto',
    )
    child.stdout.write(line({ type: 'system', subtype: 'init', session_id: 's' }))
    child.stdout.write(
      line({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        errors: ['Qoder API error: FORBIDDEN'],
      }),
    )
    child.emit('close', 0)
    await expect(p).rejects.toThrow(/FORBIDDEN/)
  })

  it('non-zero exit with no result → rejects with formatExitError', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const engine = new QoderAgentEngine(baseConfig)
    const p = getExecuteStream(engine)(
      { taskId: 't', workDir: '/tmp', prompt: 'hi', agentConfig: {} },
      'auto',
    )
    child.stderr.write('fatal: something\n')
    child.emit('close', 1)
    await expect(p).rejects.toThrow(/something/)
  })
})

// ============================================================
// probes (status / --list-models)
// ============================================================

describe('QoderAgentEngine.checkLoginStatus', () => {
  it('logged in: parses the Email line (output shape observed with 1.0.48)', async () => {
    mockRunStatusProbe.mockResolvedValue(
      probeResult({
        stdout: 'Version: 1.0.48\nUsername: Alice\nEmail: alice@example.com\nAvatar: https://x',
      }),
    )
    const engine = new QoderAgentEngine(baseConfig)
    const status = await engine.checkLoginStatus()
    expect(status).toMatchObject({ installed: true, loggedIn: true })
    expect(status.detail).toContain('alice@example.com')
  })

  it('logged out: Account: Not logged in → guides toward qodercli login', async () => {
    mockRunStatusProbe.mockResolvedValue(
      probeResult({ stdout: 'Version: 1.0.48\nAccount: Not logged in' }),
    )
    const engine = new QoderAgentEngine(baseConfig)
    const status = await engine.checkLoginStatus()
    expect(status.loggedIn).toBe(false)
    expect(status.error).toContain('qodercli login')
  })

  it('CLI not installed / timed out', async () => {
    const engine = new QoderAgentEngine(baseConfig)
    mockRunStatusProbe.mockResolvedValueOnce(probeResult({ notFound: true }))
    expect((await engine.checkLoginStatus()).installed).toBe(false)
    mockRunStatusProbe.mockResolvedValueOnce(probeResult({ timedOut: true }))
    const timedOut = await engine.checkLoginStatus()
    expect(timedOut.installed).toBe(true)
    expect(timedOut.error).toMatch(/timed out/)
  })
})

describe('QoderAgentEngine.listAvailableModels', () => {
  it('oauth → unsupported_mode; apiKey without a key → invalid_input', async () => {
    const engine = new QoderAgentEngine(baseConfig)
    expect((await engine.listAvailableModels({ authMode: 'oauth' })).code).toBe('unsupported_mode')
    expect((await engine.listAvailableModels({ authMode: 'apiKey' })).code).toBe('invalid_input')
    expect(mockRunStatusProbe).not.toHaveBeenCalled()
  })

  it('localSession: parses the table output (skipping the MODEL header)', async () => {
    mockRunStatusProbe.mockResolvedValue(
      probeResult({ stdout: 'MODEL\nUltimate\nQwen3.7-Max\nkimi-k2.7-code\n' }),
    )
    const engine = new QoderAgentEngine(baseConfig)
    const result = await engine.listAvailableModels({ authMode: 'localSession' })
    expect(result.error).toBeUndefined()
    expect(result.models).toEqual(['Ultimate', 'Qwen3.7-Max', 'kimi-k2.7-code'])
  })

  it('apiKey mode: injects the PAT env var and isolates the host login state with a throwaway --config-dir', async () => {
    mockRunStatusProbe.mockResolvedValue(probeResult({ stdout: 'MODEL\nUltimate\n' }))
    const engine = new QoderAgentEngine(baseConfig)
    const result = await engine.listAvailableModels({ authMode: 'apiKey', apiKey: 'pat-1' })
    expect(result.models).toEqual(['Ultimate'])
    const call = mockRunStatusProbe.mock.calls.at(-1)
    expect(call?.[1]).toEqual(expect.arrayContaining(['--list-models', '--config-dir']))
    expect(call?.[2]?.env?.QODER_PERSONAL_ACCESS_TOKEN).toBe('pat-1')
  })

  it('Not logged in output → local_session_not_logged_in', async () => {
    mockRunStatusProbe.mockResolvedValue(
      probeResult({ stdout: 'Not logged in. Run `qodercli login` to authenticate.\n' }),
    )
    const engine = new QoderAgentEngine(baseConfig)
    const result = await engine.listAvailableModels({ authMode: 'localSession' })
    expect(result.code).toBe('local_session_not_logged_in')
  })

  it('notFound → spawn_failed; timedOut → timeout; exit!=0 → cli_failed; empty output → parse_failed', async () => {
    const engine = new QoderAgentEngine(baseConfig)
    mockRunStatusProbe.mockResolvedValueOnce(probeResult({ notFound: true }))
    expect((await engine.listAvailableModels({ authMode: 'localSession' })).code).toBe(
      'spawn_failed',
    )
    mockRunStatusProbe.mockResolvedValueOnce(probeResult({ timedOut: true }))
    expect((await engine.listAvailableModels({ authMode: 'localSession' })).code).toBe('timeout')
    mockRunStatusProbe.mockResolvedValueOnce(probeResult({ exitCode: 1, stderr: 'err' }))
    expect((await engine.listAvailableModels({ authMode: 'localSession' })).code).toBe('cli_failed')
    mockRunStatusProbe.mockResolvedValueOnce(probeResult({ stdout: '' }))
    expect((await engine.listAvailableModels({ authMode: 'localSession' })).code).toBe(
      'parse_failed',
    )
  })
})
