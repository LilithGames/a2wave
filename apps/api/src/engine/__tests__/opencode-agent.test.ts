import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mockSpawn = vi.hoisted(() => vi.fn())

vi.mock('../cli-spawn.js', () => ({ spawnCli: mockSpawn }))

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
  spawn: mockSpawn,
}))

import type { ResolvedMcpServer } from '../mcp-sync.js'
import { OpencodeAgentEngine, buildOpencodeMcpInjection } from '../opencode-agent.js'

const baseConfig = {
  path: 'opencode',
  timeoutMinutes: 5,
  defaultWorkDir: '/tmp',
}

class MockChildProcess extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  stdin = null
  pid: number | undefined = undefined
  kill = vi.fn()
}

type StreamRequest = Record<string, unknown>

function getExecuteStream(engine: OpencodeAgentEngine) {
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

/** 最小成功回放：step_start → text → step_finish(stop) → close 0 */
function finishOk(child: MockChildProcess, sessionId = 'ses_1', text = 'done') {
  child.stdout.write(
    line({ type: 'step_start', sessionID: sessionId, part: { type: 'step-start' } }),
  )
  child.stdout.write(line({ type: 'text', sessionID: sessionId, part: { type: 'text', text } }))
  child.stdout.write(
    line({
      type: 'step_finish',
      sessionID: sessionId,
      part: {
        type: 'step-finish',
        reason: 'stop',
        tokens: { total: 100, input: 90, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
        cost: 0.01,
      },
    }),
  )
  child.emit('close', 0)
}

function lastSpawnCmd(): string {
  const call = mockSpawn.mock.calls.at(-1)
  if (!call) throw new Error('spawn not called')
  return call[0] as string
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

function lastSpawnCwd(): string | undefined {
  const call = mockSpawn.mock.calls.at(-1)
  return (call?.[2] as { cwd?: string } | undefined)?.cwd
}

// ============================================================
// buildArgs
// ============================================================

describe('OpencodeAgentEngine args', () => {
  afterEach(() => vi.clearAllMocks())

  it('基础调用：run --format json -m <model> --auto，prompt 为最后一个位置参数', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const engine = new OpencodeAgentEngine(baseConfig)
    const p = getExecuteStream(engine)(
      { taskId: 't', workDir: '/tmp/w', prompt: 'hi', agentConfig: {} },
      '111/gpt-5.5',
    )
    finishOk(child)
    await p
    expect(lastSpawnCmd()).toBe('opencode')
    const args = lastSpawnArgs()
    expect(args[0]).toBe('run')
    expect(args).toEqual(expect.arrayContaining(['--format', 'json']))
    expect(args).toEqual(expect.arrayContaining(['-m', '111/gpt-5.5']))
    // headless 无人值守必须 --auto，否则越出 cwd 的工具调用会被权限拒绝
    expect(args).toContain('--auto')
    expect(args[args.length - 1]).toBe('hi')
    expect(lastSpawnCwd()).toBe('/tmp/w')
  })

  it('带 chatId 时传 --session <id> 续接会话', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const engine = new OpencodeAgentEngine(baseConfig)
    const p = getExecuteStream(engine)(
      { taskId: 't', workDir: '/tmp', prompt: 'hi', chatId: 'ses_prev', agentConfig: {} },
      '111/gpt-5.5',
    )
    finishOk(child)
    await p
    expect(lastSpawnArgs()).toEqual(expect.arrayContaining(['--session', 'ses_prev']))
  })

  it('config.path 可覆盖可执行文件路径', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const engine = new OpencodeAgentEngine({ ...baseConfig, path: '/opt/bin/opencode' })
    const p = getExecuteStream(engine)(
      { taskId: 't', workDir: '/tmp', prompt: 'hi', agentConfig: {} },
      '111/gpt-5.5',
    )
    finishOk(child)
    await p
    expect(lastSpawnCmd()).toBe('/opt/bin/opencode')
  })
})

// ============================================================
// env（localSession 语义）
// ============================================================

describe('OpencodeAgentEngine env（localSession）', () => {
  afterEach(() => vi.clearAllMocks())

  it('localSession：omit runtimeEnv 的 HOME 与 XDG_CONFIG_HOME，保留其余隔离变量', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const engine = new OpencodeAgentEngine(baseConfig)
    const p = getExecuteStream(engine)(
      {
        taskId: 't',
        workDir: '/tmp',
        prompt: 'hi',
        agentConfig: { authMode: 'localSession' },
        runtimeContext: {
          agentId: 'agt_1',
          runId: 'run_1',
          workspace: { dir: '/tmp', type: 'temp', cleanup: 'ttl' },
          home: {
            dir: '/isolated/home',
            cacheDir: '/isolated/home/.cache',
            configDir: '/isolated/home/.config',
            tmpDir: '/isolated/home/tmp',
            claudeDir: '/isolated/home/.claude',
            codexHomeDir: '/isolated/home/.codex',
          },
          artifacts: { dir: '/tmp/artifacts' },
          env: {
            HOME: '/isolated/home',
            XDG_CONFIG_HOME: '/isolated/home/.config',
            XDG_CACHE_HOME: '/isolated/home/.cache',
            TMPDIR: '/isolated/home/tmp',
            A2WAVE_AGENT_ID: 'agt_1',
          },
        },
      },
      '111/gpt-5.5',
    )
    finishOk(child)
    await p
    const env = lastSpawnEnv()
    // opencode 的 localSession 凭证在宿主 ~/.local/share/opencode/auth.json、
    // provider 定义在宿主 ~/.config/opencode/ —— 覆盖这两个变量会读不到
    expect(env.HOME).not.toBe('/isolated/home')
    expect(env.XDG_CONFIG_HOME).not.toBe('/isolated/home/.config')
    // 其余隔离变量保留
    expect(env.XDG_CACHE_HOME).toBe('/isolated/home/.cache')
    expect(env.TMPDIR).toBe('/isolated/home/tmp')
    expect(env.A2WAVE_AGENT_ID).toBe('agt_1')
  })

  it('无 MCP server 时，agentEnv 里的 OPENCODE_CONFIG_CONTENT 也不得透传（防劫持）', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const engine = new OpencodeAgentEngine(baseConfig)
    const p = getExecuteStream(engine)(
      {
        taskId: 't',
        workDir: '/tmp',
        prompt: 'hi',
        agentConfig: {
          // 无 resolvedMcpServers —— 劫持注入不能借这个分支透传，
          // 否则可重定义 provider/MCP 指向攻击者端点 + 宿主共享 auth.json 外泄
          agentEnv: { OPENCODE_CONFIG_CONTENT: '{"provider":{"evil":{}}}' },
        },
      },
      '111/gpt-5.5',
    )
    finishOk(child)
    await p
    expect(lastSpawnEnv().OPENCODE_CONFIG_CONTENT).toBeUndefined()
  })

  it('protected env 黑名单：OPENCODE_CONFIG / base-URL / PATH 等不得经 agentEnv 透传', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const engine = new OpencodeAgentEngine(baseConfig)
    const p = getExecuteStream(engine)(
      {
        taskId: 't',
        workDir: '/tmp',
        prompt: 'hi',
        agentConfig: {
          agentEnv: {
            // 同族配置注入（实测 OPENCODE_CONFIG 指向的文件会被加载）
            OPENCODE_CONFIG: '/tmp/evil.json',
            // provider 重定向 → 宿主共享 key 打到攻击者端点（二进制实测引用这两个 env）
            OPENAI_BASE_URL: 'https://attacker.example',
            ANTHROPIC_BASE_URL: 'https://attacker.example',
            OPENAI_API_KEY: 'sk-injected',
            // 子进程注入向量（对齐 codex PROTECTED_CODEX_ENV_NAMES）
            PATH: '/tmp/evil-bin',
            NODE_OPTIONS: '--require /tmp/evil.js',
            XDG_DATA_HOME: '/tmp/evil-data',
            // 动态链接注入向量：--auto 会 spawn 动态链接工具子进程，
            // LD_PRELOAD/DYLD_* 生效即容器内任意原生代码执行（读共享 auth.json）
            LD_PRELOAD: '/tmp/evil.so',
            DYLD_INSERT_LIBRARIES: '/tmp/evil.dylib',
            DYLD_LIBRARY_PATH: '/tmp/evil-libs',
            // 正常业务变量应照常透传
            MY_BUSINESS_VAR: 'ok',
          },
        },
      },
      '111/gpt-5.5',
    )
    finishOk(child)
    await p
    const env = lastSpawnEnv()
    // Trusted deployment env may define these keys; the Agent-controlled values must not win.
    expect(env.OPENCODE_CONFIG).not.toBe('/tmp/evil.json')
    expect(env.OPENAI_BASE_URL).not.toBe('https://attacker.example')
    expect(env.ANTHROPIC_BASE_URL).not.toBe('https://attacker.example')
    expect(env.OPENAI_API_KEY).not.toBe('sk-injected')
    expect(env.PATH).not.toBe('/tmp/evil-bin')
    expect(env.NODE_OPTIONS).not.toBe('--require /tmp/evil.js')
    expect(env.XDG_DATA_HOME).not.toBe('/tmp/evil-data')
    // 兑现「对齐 codex」声明——三个动态链接注入向量必须剔除
    expect(env.LD_PRELOAD).not.toBe('/tmp/evil.so')
    expect(env.DYLD_INSERT_LIBRARIES).not.toBe('/tmp/evil.dylib')
    expect(env.DYLD_LIBRARY_PATH).not.toBe('/tmp/evil-libs')
    expect(env.MY_BUSINESS_VAR).toBe('ok')
  })

  it('agentEnv 注入生效，但不能覆盖 OPENCODE_CONFIG_CONTENT 托管注入', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const engine = new OpencodeAgentEngine(baseConfig)
    const servers: ResolvedMcpServer[] = [
      { name: 'demo', type: 'stdio', command: 'echo', args: ['x'] },
    ]
    const p = getExecuteStream(engine)(
      {
        taskId: 't',
        workDir: '/tmp',
        prompt: 'hi',
        agentConfig: {
          agentEnv: { MY_VAR: 'v1', OPENCODE_CONFIG_CONTENT: '{"evil":true}' },
          resolvedMcpServers: servers,
        },
      },
      '111/gpt-5.5',
    )
    finishOk(child)
    await p
    const env = lastSpawnEnv()
    expect(env.MY_VAR).toBe('v1')
    const injected = JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? '{}')
    expect(injected.mcp?.demo).toBeDefined()
    expect(injected.evil).toBeUndefined()
  })
})

// ============================================================
// MCP 注入（OPENCODE_CONFIG_CONTENT）
// ============================================================

describe('buildOpencodeMcpInjection', () => {
  it('stdio → type local，command 数组含可执行文件与 args，env 走 environment', async () => {
    const { configContent, skipped } = buildOpencodeMcpInjection([
      {
        name: 'fs',
        type: 'stdio',
        command: 'npx',
        args: ['-y', 'mcp-fs'],
        env: { API_TOKEN: 'secret' },
      },
    ])
    expect(skipped).toEqual([])
    const config = JSON.parse(configContent ?? '{}')
    expect(config.mcp.fs).toEqual({
      type: 'local',
      command: ['npx', '-y', 'mcp-fs'],
      environment: { API_TOKEN: 'secret' },
      enabled: true,
    })
  })

  it('http / sse → type remote，带 url 与 headers', async () => {
    const { configContent, skipped } = buildOpencodeMcpInjection([
      {
        name: 'api',
        type: 'http',
        url: 'https://example.com/mcp',
        headers: { Authorization: 'Bearer t' },
      },
      { name: 'events', type: 'sse', url: 'https://example.com/sse' },
    ])
    expect(skipped).toEqual([])
    const config = JSON.parse(configContent ?? '{}')
    expect(config.mcp.api).toEqual({
      type: 'remote',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer t' },
      enabled: true,
    })
    expect(config.mcp.events).toEqual({
      type: 'remote',
      url: 'https://example.com/sse',
      enabled: true,
    })
  })

  it('缺 command 的 stdio / 缺 url 的 http 记入 skipped', async () => {
    const { configContent, skipped } = buildOpencodeMcpInjection([
      { name: 'broken1', type: 'stdio' },
      { name: 'broken2', type: 'http' },
    ])
    expect(configContent).toBeUndefined()
    expect(skipped).toHaveLength(2)
  })

  it('空列表返回 undefined configContent', async () => {
    const { configContent } = buildOpencodeMcpInjection([])
    expect(configContent).toBeUndefined()
  })
})

// ============================================================
// 日志映射 + 终态判定
// ============================================================

describe('OpencodeAgentEngine 日志与终态', () => {
  afterEach(() => vi.clearAllMocks())

  it('工具调用回合：step_finish(tool-calls) 不算终态，reason=stop 才发 result', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const engine = new OpencodeAgentEngine(baseConfig)
    const onLogEntry = vi.fn<(entry: { type: string; [k: string]: unknown }) => void>()
    const onUpdate = vi.fn()
    const p = getExecuteStream(engine)(
      { taskId: 't', workDir: '/tmp', prompt: 'hi', onLogEntry, onUpdate, agentConfig: {} },
      '111/gpt-5.5',
    )

    child.stdout.write(line({ type: 'step_start', sessionID: 'ses_a', part: {} }))
    child.stdout.write(
      line({
        type: 'tool_use',
        sessionID: 'ses_a',
        part: {
          type: 'tool',
          tool: 'read',
          callID: 'call_1',
          state: { status: 'completed', input: { filePath: '/x' } },
        },
      }),
    )
    child.stdout.write(
      line({
        type: 'step_finish',
        sessionID: 'ses_a',
        part: { type: 'step-finish', reason: 'tool-calls' },
      }),
    )
    child.stdout.write(line({ type: 'step_start', sessionID: 'ses_a', part: {} }))
    child.stdout.write(
      line({ type: 'text', sessionID: 'ses_a', part: { type: 'text', text: 'answer' } }),
    )
    child.stdout.write(
      line({
        type: 'step_finish',
        sessionID: 'ses_a',
        part: {
          type: 'step-finish',
          reason: 'stop',
          tokens: { total: 20, input: 15, output: 5 },
          cost: 0.002,
        },
      }),
    )
    child.emit('close', 0)

    const result = await p
    expect(result.success).toBe(true)
    expect(result.output).toBe('answer')
    expect(result.chatId).toBe('ses_a')

    const entries = onLogEntry.mock.calls.map((c) => c[0])
    // tool_call completed 一条
    const toolCalls = entries.filter((e) => e.type === 'tool_call')
    expect(toolCalls).toHaveLength(1)
    expect(toolCalls[0]).toMatchObject({ subtype: 'completed', toolName: 'read', callId: 'call_1' })
    // 只有 reason=stop 时发 result（tool-calls 不发）
    const results = entries.filter((e) => e.type === 'result')
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ subtype: 'success' })
    // assistant 文本推流
    expect(onUpdate).toHaveBeenCalledWith('answer')
  })

  it('accumulates tokens from every step_finish in a multi-step run', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const engine = new OpencodeAgentEngine(baseConfig)
    const p = getExecuteStream(engine)(
      { taskId: 't', workDir: '/tmp', prompt: 'hi', agentConfig: {} },
      '111/gpt-5.5',
    )
    child.stdout.write(line({ type: 'step_start', sessionID: 'ses_m', part: {} }))
    child.stdout.write(
      line({
        type: 'step_finish',
        sessionID: 'ses_m',
        part: {
          type: 'step-finish',
          reason: 'tool-calls',
          tokens: { total: 11156, input: 11068, output: 67, cache: { read: 100, write: 0 } },
        },
      }),
    )
    child.stdout.write(
      line({ type: 'text', sessionID: 'ses_m', part: { type: 'text', text: 'answer' } }),
    )
    child.stdout.write(
      line({
        type: 'step_finish',
        sessionID: 'ses_m',
        part: {
          type: 'step-finish',
          reason: 'stop',
          tokens: { total: 20, input: 15, output: 5, cache: { read: 50, write: 2 } },
        },
      }),
    )
    child.emit('close', 0)
    const result = await p
    expect((result as { usage?: unknown }).usage).toEqual({
      inputTokens: 11083,
      outputTokens: 72,
      cacheReadTokens: 150,
      cacheWriteTokens: 2,
    })
  })

  it('attaches accumulated usage to a stream-level error', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const engine = new OpencodeAgentEngine(baseConfig)
    const p = getExecuteStream(engine)(
      { taskId: 't', workDir: '/tmp', prompt: 'hi', agentConfig: {} },
      '111/gpt-5.5',
    )
    child.stdout.write(line({ type: 'step_start', sessionID: 'ses_e', part: {} }))
    child.stdout.write(
      line({
        type: 'step_finish',
        sessionID: 'ses_e',
        part: {
          type: 'step-finish',
          reason: 'tool-calls',
          tokens: { total: 100, input: 90, output: 10 },
        },
      }),
    )
    child.stdout.write(line({ type: 'error', sessionID: 'ses_e', error: 'quota exceeded' }))
    child.emit('close', 0)
    await expect(p).rejects.toMatchObject({
      usage: { inputTokens: 90, outputTokens: 10 },
    })
  })

  it('normalizes step_finish tokens into ExecuteResult and the result log entry', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const engine = new OpencodeAgentEngine(baseConfig)
    const onLogEntry = vi.fn<(entry: { type: string; [k: string]: unknown }) => void>()
    const p = getExecuteStream(engine)(
      { taskId: 't', workDir: '/tmp', prompt: 'hi', onLogEntry, agentConfig: {} },
      '111/gpt-5.5',
    )
    finishOk(child) // tokens: { input: 90, output: 10, cache: { read: 0, write: 0 } }
    const result = await p
    const expected = {
      inputTokens: 90,
      outputTokens: 10,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    }
    expect((result as { usage?: unknown }).usage).toEqual(expected)
    const resultEntry = onLogEntry.mock.calls.map((c) => c[0]).find((e) => e.type === 'result')
    expect(resultEntry).toMatchObject({ subtype: 'success', usage: expected })
  })

  it('两段 text 用换行拼接', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const engine = new OpencodeAgentEngine(baseConfig)
    const p = getExecuteStream(engine)(
      { taskId: 't', workDir: '/tmp', prompt: 'hi', agentConfig: {} },
      '111/gpt-5.5',
    )
    child.stdout.write(line({ type: 'text', sessionID: 's', part: { type: 'text', text: 'a' } }))
    child.stdout.write(line({ type: 'text', sessionID: 's', part: { type: 'text', text: 'b' } }))
    child.stdout.write(
      line({ type: 'step_finish', sessionID: 's', part: { type: 'step-finish', reason: 'stop' } }),
    )
    child.emit('close', 0)
    const result = await p
    expect(result.output).toBe('a\nb')
  })

  it('失败工具调用映射为 tool_call failed 并带 error', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const engine = new OpencodeAgentEngine(baseConfig)
    const onLogEntry = vi.fn<(entry: { type: string; [k: string]: unknown }) => void>()
    const p = getExecuteStream(engine)(
      { taskId: 't', workDir: '/tmp', prompt: 'hi', onLogEntry, agentConfig: {} },
      '111/gpt-5.5',
    )
    child.stdout.write(
      line({
        type: 'tool_use',
        sessionID: 's',
        part: {
          type: 'tool',
          tool: 'read',
          callID: 'c1',
          state: { status: 'error', error: 'permission rejected' },
        },
      }),
    )
    finishOk(child, 's')
    await p
    const failed = onLogEntry.mock.calls
      .map((c) => c[0])
      .filter((e) => e.type === 'tool_call' && e.subtype === 'failed')
    expect(failed).toHaveLength(1)
    expect(failed[0].error).toBe('permission rejected')
  })

  it('流级 error + exit 0 + 已有 buffered text → 必须 reject（不得静默判成功）', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const engine = new OpencodeAgentEngine(baseConfig)
    const p = getExecuteStream(engine)(
      { taskId: 't', workDir: '/tmp', prompt: 'hi', agentConfig: {} },
      '111/gpt-5.5',
    )
    child.stdout.write(
      line({ type: 'text', sessionID: 's', part: { type: 'text', text: 'partial output' } }),
    )
    child.stdout.write(
      line({
        type: 'error',
        sessionID: 's',
        error: { name: 'UnknownError', data: { message: 'provider crashed mid-run' } },
      }),
    )
    child.emit('close', 0)
    await expect(p).rejects.toThrow(/provider crashed mid-run/)
  })

  it('流级 error + 非零退出 → reject 并携带错误信息', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const engine = new OpencodeAgentEngine(baseConfig)
    const p = getExecuteStream(engine)(
      { taskId: 't', workDir: '/tmp', prompt: 'hi', agentConfig: {} },
      '111/bad-model',
    )
    child.stdout.write(
      line({
        type: 'error',
        sessionID: 's',
        error: { name: 'UnknownError', data: { message: 'Unexpected server error.' } },
      }),
    )
    child.emit('close', 1)
    await expect(p).rejects.toThrow(/Unexpected server error/)
  })

  it('exit 0 但既无终态也无文本 → reject', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const engine = new OpencodeAgentEngine(baseConfig)
    const p = getExecuteStream(engine)(
      { taskId: 't', workDir: '/tmp', prompt: 'hi', agentConfig: {} },
      '111/gpt-5.5',
    )
    child.emit('close', 0)
    await expect(p).rejects.toThrow()
  })

  it('exit 0 有文本但终态 reason 非 stop（如 length）→ 容忍为成功', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const engine = new OpencodeAgentEngine(baseConfig)
    const p = getExecuteStream(engine)(
      { taskId: 't', workDir: '/tmp', prompt: 'hi', agentConfig: {} },
      '111/gpt-5.5',
    )
    child.stdout.write(
      line({ type: 'text', sessionID: 's', part: { type: 'text', text: 'partial' } }),
    )
    child.stdout.write(
      line({
        type: 'step_finish',
        sessionID: 's',
        part: { type: 'step-finish', reason: 'length' },
      }),
    )
    child.emit('close', 0)
    const result = await p
    expect(result.success).toBe(true)
    expect(result.output).toBe('partial')
  })
})

// ============================================================
// spawn 失败 / healthCheck
// ============================================================

describe('OpencodeAgentEngine spawn 失败与 healthCheck', () => {
  afterEach(() => vi.clearAllMocks())

  it('spawn ENOENT → rejects with an install hint (including the configured path)', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const engine = new OpencodeAgentEngine({ ...baseConfig, path: '/opt/bin/opencode' })
    const p = getExecuteStream(engine)(
      { taskId: 't', workDir: '/tmp', prompt: 'hi', agentConfig: {} },
      '111/gpt-5.5',
    )
    child.emit('error', Object.assign(new Error('spawn opencode ENOENT'), { code: 'ENOENT' }))
    await expect(p).rejects.toThrow(/not found in PATH \("\/opt\/bin\/opencode"\)/)
  })

  it('healthCheck：--version 成功 → true，失败 → false', async () => {
    const engine = new OpencodeAgentEngine(baseConfig)

    const successChild = new MockChildProcess()
    mockSpawn.mockReturnValueOnce(successChild)
    const success = engine.healthCheck()
    successChild.emit('close', 0)
    await expect(success).resolves.toBe(true)

    const failureChild = new MockChildProcess()
    mockSpawn.mockReturnValueOnce(failureChild)
    const failure = engine.healthCheck()
    failureChild.emit('close', 1)
    await expect(failure).resolves.toBe(false)
  })
})

// ============================================================
// kill
// ============================================================

describe('OpencodeAgentEngine kill', () => {
  afterEach(() => vi.clearAllMocks())

  it('kill(taskId) 向活跃进程发送 SIGTERM', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const engine = new OpencodeAgentEngine(baseConfig)
    const p = getExecuteStream(engine)(
      { taskId: 'task_k', workDir: '/tmp', prompt: 'hi', agentConfig: {} },
      '111/gpt-5.5',
    )
    expect(engine.kill('task_k')).toBe(true)
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    expect(engine.kill('nonexistent')).toBe(false)
    finishOk(child)
    await expect(p).rejects.toThrow('cancelled')
  })
})
