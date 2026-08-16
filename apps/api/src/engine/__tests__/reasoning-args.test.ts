/**
 * Reasoning effort and fast mode reach the CLI.
 *
 * Both settings are resolved from the provider binding that is actually running
 * (see provider-binding-reasoning.test.ts) and end up on the command line here.
 * The rule these tests pin is that an unset control passes NOTHING: the CLI's
 * own default is the fallback, never a value a2wave invented.
 */
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mockSpawn = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
  spawn: mockSpawn,
}))

import { ClaudeCodeEngine } from '../claude-code.js'
import { CodexAgentEngine } from '../codex-agent.js'

class MockChildProcess extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  stdin = null
  pid = 4242
  kill = vi.fn()
}

type StreamRequest = Record<string, unknown>

function getExecuteStream(engine: ClaudeCodeEngine | CodexAgentEngine) {
  return (
    engine as unknown as {
      executeStreamWithModel: (request: StreamRequest, model: string) => Promise<unknown>
    }
  ).executeStreamWithModel.bind(engine)
}

function lastSpawnArgs(): string[] {
  const call = mockSpawn.mock.calls.at(-1)
  if (!call) throw new Error('spawn was not called')
  return call[1] as string[]
}

function finishClaudeRun(child: MockChildProcess) {
  child.stdout.write(
    `${JSON.stringify({ type: 'result', subtype: 'success', result: 'ok', duration_ms: 1 })}\n`,
  )
  child.emit('close', 0)
}

function finishCodexRun(child: MockChildProcess) {
  child.stdout.write(`${JSON.stringify({ type: 'thread.started', thread_id: 't1' })}\n`)
  child.stdout.write(`${JSON.stringify({ type: 'turn.completed' })}\n`)
  child.emit('close', 0)
}

afterEach(() => vi.clearAllMocks())

describe('claude-code reasoning arguments', () => {
  const engineConfig = {
    path: 'claude',
    apiKey: '',
    baseUrl: '',
    timeoutMinutes: 5,
    force: true,
    approveMcps: true,
    defaultWorkDir: '/tmp',
  }

  async function runWith(agentConfig: Record<string, unknown>, chatId?: string) {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const engine = new ClaudeCodeEngine(engineConfig)
    const promise = getExecuteStream(engine)(
      { taskId: 't', workDir: '/tmp', prompt: 'hi', agentConfig, ...(chatId ? { chatId } : {}) },
      'claude-opus-4-8',
    )
    finishClaudeRun(child)
    await promise
    return lastSpawnArgs()
  }

  it('passes the configured level as --effort', async () => {
    const args = await runWith({ reasoningEffort: 'xhigh' })

    // Adjacency, not membership: `arrayContaining` passes on
    // `['--effort', '--model', 'opus', 'xhigh']`, where the CLI would read
    // `--model` as the level and fail at spawn.
    const index = args.indexOf('--effort')
    expect(index).toBeGreaterThan(-1)
    expect(args[index + 1]).toBe('xhigh')
  })

  it('turns fast mode on through --settings, the only headless entry point', async () => {
    const args = await runWith({ fastMode: true })

    const index = args.indexOf('--settings')
    expect(index).toBeGreaterThan(-1)
    expect(JSON.parse(args[index + 1] as string)).toEqual({ fastMode: true })
  })

  it('passes neither flag when neither is configured', async () => {
    const args = await runWith({})

    expect(args).not.toContain('--effort')
    expect(args).not.toContain('--settings')
  })

  it('passes no --settings when fast mode is explicitly off', async () => {
    // Off must mean "say nothing", not "say false": the CLI reads its own
    // settings files too, and a2wave has no business overriding a user default
    // it was never asked to touch.
    const args = await runWith({ fastMode: false })

    expect(args).not.toContain('--settings')
  })

  it('keeps both on a resumed session', async () => {
    const args = await runWith({ reasoningEffort: 'high', fastMode: true }, 'sess_1')

    expect(args).toEqual(expect.arrayContaining(['--resume', 'sess_1']))
    const index = args.indexOf('--effort')
    expect(index).toBeGreaterThan(-1)
    expect(args[index + 1]).toBe('high')
    expect(args).toContain('--settings')
  })
})

describe('codex reasoning arguments', () => {
  const baseConfig = {
    path: 'codex',
    apiKey: '',
    timeoutMinutes: 5,
    force: false,
    approveMcps: true,
    defaultWorkDir: '/tmp',
  }

  async function runWith(agentConfig: Record<string, unknown>, chatId?: string) {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const engine = new CodexAgentEngine(baseConfig)
    const promise = getExecuteStream(engine)(
      { taskId: 't', workDir: '/tmp', prompt: 'hi', agentConfig, ...(chatId ? { chatId } : {}) },
      'gpt-5.6-sol',
    )
    finishCodexRun(child)
    await promise
    return lastSpawnArgs()
  }

  it('passes the configured level as a config override', async () => {
    const args = await runWith({ reasoningEffort: 'ultra' })

    expect(args).toEqual(expect.arrayContaining(['-c', 'model_reasoning_effort="ultra"']))
  })

  it('requests the faster service tier for fast mode', async () => {
    const args = await runWith({ fastMode: true })

    expect(args).toEqual(expect.arrayContaining(['-c', 'service_tier="priority"']))
  })

  it('passes neither override when neither is configured', async () => {
    const args = await runWith({})

    expect(args.join(' ')).not.toContain('model_reasoning_effort')
    expect(args.join(' ')).not.toContain('service_tier')
  })

  it('keeps both on a resumed session', async () => {
    // `-c` is accepted on `codex exec resume`, unlike --sandbox, so the settings
    // must be re-passed: a resumed turn would otherwise silently drop back to
    // the CLI defaults halfway through a conversation.
    const args = await runWith({ reasoningEffort: 'high', fastMode: true }, 'thread_1')

    expect(args.slice(0, 3)).toEqual(['exec', 'resume', 'thread_1'])
    expect(args).toEqual(expect.arrayContaining(['-c', 'model_reasoning_effort="high"']))
    expect(args).toEqual(expect.arrayContaining(['-c', 'service_tier="priority"']))
  })
})

/**
 * Fast mode is requested, never guaranteed: it also needs first-party Anthropic
 * auth, a model that supports it and an eligible plan. The CLI settles that at
 * run time and reports the outcome on its result line, so a2wave records what
 * actually happened instead of leaving the switch as the only evidence.
 */
describe('claude-code fast mode outcome', () => {
  const engineConfig = {
    path: 'claude',
    apiKey: '',
    baseUrl: '',
    timeoutMinutes: 5,
    force: true,
    approveMcps: true,
    defaultWorkDir: '/tmp',
  }

  async function runReporting(resultLine: Record<string, unknown>) {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const entries: Array<Record<string, unknown>> = []
    const engine = new ClaudeCodeEngine(engineConfig)
    const promise = getExecuteStream(engine)(
      {
        taskId: 't',
        workDir: '/tmp',
        prompt: 'hi',
        agentConfig: { fastMode: true },
        onLogEntry: (entry: Record<string, unknown>) => entries.push(entry),
      },
      'claude-opus-4-8',
    )
    child.stdout.write(`${JSON.stringify(resultLine)}\n`)
    child.emit('close', 0)
    await promise
    return entries.find((entry) => entry.type === 'result')
  }

  it('records that the run really got the faster path', async () => {
    const result = await runReporting({
      type: 'result',
      subtype: 'success',
      result: 'ok',
      duration_ms: 1,
      fast_mode_state: 'on',
    })

    expect(result?.fastModeState).toBe('on')
  })

  it('records that it did not, which the switch alone cannot tell you', async () => {
    const result = await runReporting({
      type: 'result',
      subtype: 'success',
      result: 'ok',
      duration_ms: 1,
      fast_mode_state: 'off',
    })

    expect(result?.fastModeState).toBe('off')
  })

  it('passes through a cooldown verdict verbatim rather than folding it into off', async () => {
    const result = await runReporting({
      type: 'result',
      subtype: 'success',
      result: 'ok',
      duration_ms: 1,
      fast_mode_state: 'cooldown',
    })

    expect(result?.fastModeState).toBe('cooldown')
  })

  it('omits the field when the CLI reports nothing, rather than inventing "off"', async () => {
    // Older CLIs and every non-Claude engine report no such state. Defaulting to
    // "off" would claim a verdict nobody issued.
    const result = await runReporting({
      type: 'result',
      subtype: 'success',
      result: 'ok',
      duration_ms: 1,
    })

    expect(result).toBeDefined()
    expect(result?.fastModeState).toBeUndefined()
  })

  it('ignores a value that is not one of the states the CLI defines', async () => {
    const result = await runReporting({
      type: 'result',
      subtype: 'success',
      result: 'ok',
      duration_ms: 1,
      fast_mode_state: { nested: true },
    })

    expect(result?.fastModeState).toBeUndefined()
  })

  it('drops a state string the closed set does not define, rather than echoing it', async () => {
    // The token reaches the run record, the web log and a terminal. Every other
    // third-party value in this engine is capped or shape-checked; an unknown
    // state degrades to absent, which the UI already renders as "said nothing".
    const result = await runReporting({
      type: 'result',
      subtype: 'success',
      result: 'ok',
      duration_ms: 1,
      fast_mode_state: `throttled${'x'.repeat(500)}`,
    })

    expect(result?.fastModeState).toBeUndefined()
  })
})

/**
 * The log records what the SERVER did, not what the client asked for.
 *
 * `fast_mode_state` is the CLI's own intent — it flips to `on` as soon as the
 * request is allowed to leave. `usage.speed` is what Anthropic actually served.
 * The two disagree on exactly the case that matters: an account without usage
 * credits gets `fast_mode_state: on` and `speed: standard`, no error. Recording
 * the intent would put a green "Fast" marker on a run that never ran fast.
 */
describe('claude-code fast mode verdict prefers the served speed', () => {
  const engineConfig = {
    path: 'claude',
    apiKey: '',
    baseUrl: '',
    timeoutMinutes: 5,
    force: true,
    approveMcps: true,
    defaultWorkDir: '/tmp',
  }

  async function stateOf(resultLine: Record<string, unknown>) {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const entries: Array<Record<string, unknown>> = []
    const engine = new ClaudeCodeEngine(engineConfig)
    const promise = getExecuteStream(engine)(
      {
        taskId: 't',
        workDir: '/tmp',
        prompt: 'hi',
        agentConfig: { fastMode: true },
        onLogEntry: (entry: Record<string, unknown>) => entries.push(entry),
      },
      'claude-opus-4-8',
    )
    child.stdout.write(`${JSON.stringify(resultLine)}\n`)
    child.emit('close', 0)
    await promise
    return entries.find((entry) => entry.type === 'result')?.fastModeState
  }

  const base = { type: 'result', subtype: 'success', result: 'ok', duration_ms: 1 }

  it('reports on only when the server actually served the faster path', async () => {
    expect(await stateOf({ ...base, fast_mode_state: 'on', usage: { speed: 'fast' } })).toBe('on')
  })

  it('reports "denied" when the client asked but the server served standard', async () => {
    // The real shape of an account with usage credits disabled: allowed out,
    // billed and served as standard, no error anywhere. Distinct from
    // "requested", which means nobody ever answered.
    expect(await stateOf({ ...base, fast_mode_state: 'on', usage: { speed: 'standard' } })).toBe(
      'denied',
    )
  })

  it('reports off when nothing was asked for and nothing was served', async () => {
    expect(await stateOf({ ...base, fast_mode_state: 'off', usage: { speed: 'standard' } })).toBe(
      'off',
    )
  })

  it('keeps a cooldown verdict, which the served speed cannot express', async () => {
    expect(
      await stateOf({ ...base, fast_mode_state: 'cooldown', usage: { speed: 'standard' } }),
    ).toBe('cooldown')
  })

  it('falls back to the client verdict when the server reports no speed', async () => {
    expect(await stateOf({ ...base, fast_mode_state: 'on' })).toBe('on')
  })

  it('stays absent when neither source says anything', async () => {
    expect(await stateOf(base)).toBeUndefined()
  })
})

/**
 * codex's `--json` stream reports only a thread id and token usage — no model,
 * no duration, and nothing at all about the service tier. The first two are
 * facts a2wave already holds and simply failed to write down; the third has no
 * source and is therefore left unstated rather than guessed.
 */
describe('codex run log completeness', () => {
  const baseConfig = {
    path: 'codex',
    apiKey: '',
    timeoutMinutes: 5,
    force: false,
    approveMcps: true,
    defaultWorkDir: '/tmp',
  }

  async function entriesOf(agentConfig: Record<string, unknown>) {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const entries: Array<Record<string, unknown>> = []
    const engine = new CodexAgentEngine(baseConfig)
    const promise = getExecuteStream(engine)(
      {
        taskId: 't',
        workDir: '/tmp',
        prompt: 'hi',
        agentConfig,
        onLogEntry: (entry: Record<string, unknown>) => entries.push(entry),
      },
      'gpt-5.6-sol',
    )
    finishCodexRun(child)
    await promise
    return entries
  }

  it('records the model it ran, which the engine never reports', async () => {
    const init = (await entriesOf({})).find(
      (entry) => entry.type === 'system' && entry.subtype === 'init',
    )

    expect(init?.model).toBe('gpt-5.6-sol')
  })

  it('records a duration measured by the platform, not a wall-clock timestamp', async () => {
    const result = (await entriesOf({})).find((entry) => entry.type === 'result')

    expect(typeof result?.durationMs).toBe('number')
    expect(result?.durationMs).toBeGreaterThanOrEqual(0)
    // The upper bound is what distinguishes an elapsed delta from `Date.now()`:
    // returning the raw epoch also satisfies "a non-negative number", and would
    // print a ~1.7-trillion-ms run duration everywhere it surfaces.
    expect(result?.durationMs).toBeLessThan(60_000)
  })

  // codex reports nothing at all about the served tier, so `requested` is the
  // most the platform can claim — and claiming it is what puts the Fast marker
  // on the run summary and `fastMode=requested` in the CLI log.
  it('records that fast mode was requested, which is all codex ever admits', async () => {
    const result = (await entriesOf({ fastMode: true })).find((entry) => entry.type === 'result')

    expect(result?.fastModeState).toBe('requested')
  })

  it('claims nothing about fast mode when none was asked for', async () => {
    const result = (await entriesOf({})).find((entry) => entry.type === 'result')

    // Absent, never `off`: the engine did not answer, and inventing a verdict is
    // exactly what the claude-code path treats as a bug.
    expect(result?.fastModeState).toBeUndefined()
  })

  // Both controls travel as blanket-redacted `-c` overrides, so the exec params
  // are the only place their values survive for someone reading a slow run.
  it('names both controls in the exec params the CLI and web read', async () => {
    const params = (await entriesOf({ reasoningEffort: 'ultra', fastMode: true })).find(
      (entry) => entry.type === 'exec_params',
    )?.params as Record<string, unknown>

    expect(params.reasoningEffort).toBe('ultra')
    expect(params.fastMode).toBe(true)
  })

  it('leaves both out of the exec params when neither is configured', async () => {
    const params = (await entriesOf({})).find((entry) => entry.type === 'exec_params')
      ?.params as Record<string, unknown>

    expect(params).not.toHaveProperty('reasoningEffort')
    expect(params).not.toHaveProperty('fastMode')
  })
})
