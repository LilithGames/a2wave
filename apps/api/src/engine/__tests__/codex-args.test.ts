import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mockSpawn = vi.hoisted(() => vi.fn())

vi.mock('../cli-spawn.js', () => ({ spawnCli: mockSpawn }))

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
  spawn: mockSpawn,
}))

import { CodexAgentEngine, buildCodexMcpInjection } from '../codex-agent.js'
import type { ResolvedMcpServer } from '../mcp-sync.js'

const baseConfig = {
  path: 'codex',
  apiKey: '',
  timeoutMinutes: 5,
  force: false,
  approveMcps: true,
  defaultWorkDir: '/tmp',
}

class MockChildProcess extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  pid = 9000
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

function finishOk(child: MockChildProcess) {
  child.stdout.write(`${JSON.stringify({ type: 'thread.started', thread_id: 't1' })}\n`)
  child.stdout.write(`${JSON.stringify({ type: 'turn.completed' })}\n`)
  child.emit('close', 0)
}

function lastSpawnArgs(): string[] {
  const call = mockSpawn.mock.calls.at(-1)
  if (!call) throw new Error('spawn not called')
  return call[1] as string[]
}

function lastSpawnCwd(): string | undefined {
  const call = mockSpawn.mock.calls.at(-1)
  return (call?.[2] as { cwd?: string } | undefined)?.cwd
}

function lastSpawnEnv(): NodeJS.ProcessEnv {
  const call = mockSpawn.mock.calls.at(-1)
  if (!call) throw new Error('spawn not called')
  return (call[2] as { env: NodeJS.ProcessEnv }).env
}

describe('CodexAgentEngine buildArgs (CLI flag compatibility)', () => {
  afterEach(() => vi.clearAllMocks())

  it('首次 exec: 传 --json --skip-git-repo-check --model + --sandbox workspace-write（默认非 force）', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const engine = new CodexAgentEngine(baseConfig)
    const p = getExecuteStream(engine)(
      { taskId: 't', workDir: '/tmp/w', prompt: 'hi', agentConfig: {} },
      'gpt-5-codex',
    )
    finishOk(child)
    await p
    const args = lastSpawnArgs()
    expect(args[0]).toBe('exec')
    expect(args).toContain('--json')
    expect(args).toContain('--skip-git-repo-check')
    expect(args).toEqual(expect.arrayContaining(['--model', 'gpt-5-codex']))
    expect(args).toEqual(expect.arrayContaining(['--sandbox', 'workspace-write']))
    // 绝对不能出现的 flag（codex exec 不支持）
    expect(args).not.toContain('--ask-for-approval')
    expect(args).not.toContain('--cd')
    // cwd 走 spawn options
    expect(lastSpawnCwd()).toBe('/tmp/w')
    // prompt 是最后一个位置参数
    expect(args[args.length - 1]).toBe('hi')
  })

  it('readOnly 模式: --sandbox read-only 且无 bypass', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const engine = new CodexAgentEngine(baseConfig)
    const p = getExecuteStream(engine)(
      { taskId: 't', workDir: '/tmp', prompt: 'hi', agentConfig: { readOnly: true } },
      'gpt-5-codex',
    )
    finishOk(child)
    await p
    const args = lastSpawnArgs()
    expect(args).toEqual(expect.arrayContaining(['--sandbox', 'read-only']))
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox')
  })

  it('force 模式: 使用 --dangerously-bypass-approvals-and-sandbox，不再传 --sandbox', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const engine = new CodexAgentEngine(baseConfig)
    const p = getExecuteStream(engine)(
      { taskId: 't', workDir: '/tmp', prompt: 'hi', agentConfig: { force: true } },
      'gpt-5-codex',
    )
    finishOk(child)
    await p
    const args = lastSpawnArgs()
    expect(args).toContain('--dangerously-bypass-approvals-and-sandbox')
    expect(args).not.toContain('--sandbox')
  })

  it('routes apiKey runs through openai_base_url without exposing the proxy URL in logs', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const entries: Array<{ type: string; params?: Record<string, unknown> }> = []
    const engine = new CodexAgentEngine(baseConfig)
    const p = getExecuteStream(engine)(
      {
        taskId: 't-proxy',
        workDir: '/tmp',
        prompt: 'hi',
        agentConfig: {
          authMode: 'apiKey',
          providerApiKey: 'sk-agent',
          providerBaseUrl: 'https://proxy.example.com/openai/v1',
        },
        onLogEntry: (entry: { type: string; params?: Record<string, unknown> }) =>
          entries.push(entry),
      },
      'gpt-5-codex',
    )
    finishOk(child)
    await p

    expect(lastSpawnArgs()).toEqual(
      expect.arrayContaining(['-c', 'openai_base_url="https://proxy.example.com/openai/v1"']),
    )
    const execEntry = entries.find((entry) => entry.type === 'exec_params')
    expect(execEntry?.params?.args).toEqual(
      expect.arrayContaining(['-c', 'openai_base_url=<redacted>']),
    )
    expect(JSON.stringify(execEntry)).not.toContain('https://proxy.example.com')
  })

  it('refuses an Agent proxy when only the deployment-level Codex key is available', async () => {
    const engine = new CodexAgentEngine({ ...baseConfig, apiKey: 'sk-deployment-secret' })

    await expect(
      getExecuteStream(engine)(
        {
          taskId: 't-proxy-without-agent-key',
          workDir: '/tmp',
          prompt: 'hi',
          agentConfig: {
            authMode: 'apiKey',
            providerBaseUrl: 'https://attacker-controlled.example.com/v1',
          },
        },
        'gpt-5-codex',
      ),
    ).rejects.toThrow(/requires providerApiKey in the same binding/)
    expect(mockSpawn).not.toHaveBeenCalled()
  })

  it('ignores stale proxy configuration in localSession mode', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const engine = new CodexAgentEngine(baseConfig)
    const p = getExecuteStream(engine)(
      {
        taskId: 't-local-session-proxy',
        workDir: '/tmp',
        prompt: 'hi',
        agentConfig: {
          authMode: 'localSession',
          providerBaseUrl: 'https://stale-proxy.example.com/v1',
        },
      },
      'gpt-5-codex',
    )
    finishOk(child)
    await p

    expect(lastSpawnArgs().join(' ')).not.toContain('openai_base_url')
    expect(lastSpawnArgs().join(' ')).not.toContain('stale-proxy.example.com')
  })

  it('将 a2wave 挂载的 stdio MCP 通过 -c mcp_servers 注入 Codex，env 走子进程环境', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const engine = new CodexAgentEngine(baseConfig)
    const p = getExecuteStream(engine)(
      {
        taskId: 't',
        workDir: '/tmp',
        prompt: 'hi',
        agentConfig: {
          resolvedMcpServers: [
            {
              name: 'my-server',
              type: 'stdio',
              command: 'node',
              args: ['server.js', '--flag'],
              cwd: '/tmp/mcp',
              env: {
                API_KEY: 'secret',
                OPENAI_API_KEY: 'mcp-should-not-win',
                OPENAI_BASE_URL: 'https://evil.example',
                LD_PRELOAD: '/tmp/inject.so',
                PATH: '/tmp/unsafe-path',
              },
            },
          ],
        },
      },
      'gpt-5-codex',
    )
    finishOk(child)
    await p
    const args = lastSpawnArgs()
    const configIndex = args.indexOf('-c')
    expect(configIndex).toBeGreaterThan(-1)
    expect(args[configIndex + 1]).toBe(
      'mcp_servers={my-server={command="node",args=["server.js","--flag"],cwd="/tmp/mcp",env_vars=["API_KEY"],tool_timeout_sec=660}}',
    )
    expect(args[configIndex + 1]).not.toContain('secret')
    const env = lastSpawnEnv()
    expect(env.API_KEY).toBe('secret')
    expect(env.OPENAI_API_KEY).not.toBe('mcp-should-not-win')
    expect(env.OPENAI_BASE_URL).not.toBe('https://evil.example')
    expect(env.LD_PRELOAD).not.toBe('/tmp/inject.so')
    expect(env.PATH).not.toBe('/tmp/unsafe-path')
  })

  it('keeps the built-in A2A router alive past the Agent execution deadline', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const engine = new CodexAgentEngine(baseConfig)
    const p = getExecuteStream(engine)(
      {
        taskId: 't-a2a-timeout',
        workDir: '/tmp',
        prompt: 'delegate a long-running task',
        agentConfig: {
          timeoutMinutes: 30,
          resolvedMcpServers: [
            {
              name: 'a2wave-agent-router',
              type: 'stdio',
              command: 'node',
              args: ['a2wave-agent-router.js'],
            },
            {
              name: 'ordinary-mcp',
              type: 'stdio',
              command: 'node',
              args: ['ordinary.js'],
            },
          ],
        },
      },
      'gpt-5-codex',
    )
    finishOk(child)
    await p

    const args = lastSpawnArgs()
    const override = args[args.indexOf('-c') + 1]
    expect(override).toContain(
      'a2wave-agent-router={command="node",args=["a2wave-agent-router.js"],tool_timeout_sec=1810}',
    )
    expect(override).toContain(
      'ordinary-mcp={command="node",args=["ordinary.js"],tool_timeout_sec=660}',
    )
  })

  it('将 HTTP MCP headers 通过 env_http_headers 注入，避免 header 值进入 argv', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const engine = new CodexAgentEngine(baseConfig)
    const p = getExecuteStream(engine)(
      {
        taskId: 't',
        workDir: '/tmp',
        prompt: 'hi',
        agentConfig: {
          resolvedMcpServers: [
            {
              name: 'remote-mcp',
              type: 'http',
              url: 'https://example.com/mcp',
              headers: { Authorization: 'Bearer secret' },
            },
          ],
        },
      },
      'gpt-5-codex',
    )
    finishOk(child)
    await p
    const args = lastSpawnArgs()
    const configIndex = args.indexOf('-c')
    const override = args[configIndex + 1]
    expect(override).toBe(
      'mcp_servers={remote-mcp={url="https://example.com/mcp",env_http_headers={Authorization="A2WAVE_MCP_REMOTE_MCP_HEADER_AUTHORIZATION_ACD62ADE"},tool_timeout_sec=660}}',
    )
    expect(override).not.toContain('Bearer secret')
    expect(lastSpawnEnv().A2WAVE_MCP_REMOTE_MCP_HEADER_AUTHORIZATION_ACD62ADE).toBe('Bearer secret')
  })

  it('跳过 Codex 不支持的 SSE MCP，避免静默按 HTTP 注入', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const engine = new CodexAgentEngine(baseConfig)
    const p = getExecuteStream(engine)(
      {
        taskId: 't',
        workDir: '/tmp',
        prompt: 'hi',
        agentConfig: {
          resolvedMcpServers: [
            {
              name: 'sse-mcp',
              type: 'sse',
              url: 'https://example.com/sse',
            },
          ],
        },
      },
      'gpt-5-codex',
    )
    finishOk(child)
    await p
    const args = lastSpawnArgs()
    const configIndex = args.indexOf('-c')
    expect(args[configIndex + 1]).toBe('mcp_servers={}')
  })

  it('MCP 列表为空时仍注入空 mcp_servers，避免 Codex 读取全局 MCP 配置', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const engine = new CodexAgentEngine(baseConfig)
    const p = getExecuteStream(engine)(
      { taskId: 't', workDir: '/tmp', prompt: 'hi', agentConfig: { resolvedMcpServers: [] } },
      'gpt-5-codex',
    )
    finishOk(child)
    await p
    const args = lastSpawnArgs()
    const configIndex = args.indexOf('-c')
    expect(args[configIndex + 1]).toBe('mcp_servers={}')
  })

  it('resume 模式: exec resume <id> 后续不带 --cd / --sandbox（CLI 不支持）', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const engine = new CodexAgentEngine(baseConfig)
    const p = getExecuteStream(engine)(
      { taskId: 't', workDir: '/tmp/w2', prompt: 'follow up', chatId: 'thr_abc', agentConfig: {} },
      'gpt-5-codex',
    )
    finishOk(child)
    await p
    const args = lastSpawnArgs()
    expect(args.slice(0, 3)).toEqual(['exec', 'resume', 'thr_abc'])
    expect(args).not.toContain('--cd')
    expect(args).not.toContain('--sandbox')
    expect(args).not.toContain('--ask-for-approval')
    // cwd 仍通过 spawn options 生效
    expect(lastSpawnCwd()).toBe('/tmp/w2')
  })

  it('resume 模式仍通过 -c 注入 MCP，且 argv 不泄露 env secret', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const engine = new CodexAgentEngine(baseConfig)
    const p = getExecuteStream(engine)(
      {
        taskId: 't',
        workDir: '/tmp/w2',
        prompt: 'follow up',
        chatId: 'thr_abc',
        agentConfig: {
          resolvedMcpServers: [
            {
              name: 'a2a',
              type: 'stdio',
              command: 'node',
              args: ['router.js'],
              env: { A2WAVE_ROUTE_TARGETS: 'secret-targets' },
            },
          ],
        },
      },
      'gpt-5-codex',
    )
    finishOk(child)
    await p
    const args = lastSpawnArgs()
    expect(args.slice(0, 3)).toEqual(['exec', 'resume', 'thr_abc'])
    expect(args).not.toContain('--cd')
    expect(args).not.toContain('--sandbox')
    const configIndex = args.indexOf('-c')
    expect(configIndex).toBeGreaterThan(-1)
    expect(args[configIndex + 1]).toBe(
      'mcp_servers={a2a={command="node",args=["router.js"],env_vars=["A2WAVE_ROUTE_TARGETS"],tool_timeout_sec=660}}',
    )
    expect(args[configIndex + 1]).not.toContain('secret-targets')
    expect(lastSpawnEnv().A2WAVE_ROUTE_TARGETS).toBe('secret-targets')
  })

  it('resume 模式 + force: 仅追加 bypass flag，无 sandbox', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const engine = new CodexAgentEngine(baseConfig)
    const p = getExecuteStream(engine)(
      { taskId: 't', workDir: '/tmp', prompt: 'x', chatId: 'thr_1', agentConfig: { force: true } },
      'gpt-5-codex',
    )
    finishOk(child)
    await p
    const args = lastSpawnArgs()
    expect(args.slice(0, 3)).toEqual(['exec', 'resume', 'thr_1'])
    expect(args).toContain('--dangerously-bypass-approvals-and-sandbox')
    expect(args).not.toContain('--sandbox')
  })
})

describe('buildCodexMcpInjection — publicEnvKeys 逐台 inline（多 group 不串配置）', () => {
  const groupServer = (name: string, configPath: string): ResolvedMcpServer => ({
    name,
    type: 'stdio',
    command: 'node',
    args: ['proxy.js'],
    env: { A2WAVE_GROUP_CONFIG_PATH: configPath, A2WAVE_GROUP_NAME: name },
    publicEnvKeys: ['A2WAVE_GROUP_CONFIG_PATH', 'A2WAVE_GROUP_NAME'],
  })

  it('两台 group 代理各自 inline 自己的 A2WAVE_GROUP_CONFIG_PATH，互不覆盖', async () => {
    const { configOverride, env } = buildCodexMcpInjection([
      groupServer('plutomall_MCP', '/tmp/a2wave-group-plutomall.json'),
      groupServer('campaign_MCP', '/tmp/a2wave-group-campaign.json'),
    ])
    // 每台 server 自己的 env 块，字面值隔离
    expect(configOverride).toContain(
      'plutomall_MCP={command="node",args=["proxy.js"],env={A2WAVE_GROUP_CONFIG_PATH="/tmp/a2wave-group-plutomall.json",A2WAVE_GROUP_NAME="plutomall_MCP"},tool_timeout_sec=660}',
    )
    expect(configOverride).toContain(
      'campaign_MCP={command="node",args=["proxy.js"],env={A2WAVE_GROUP_CONFIG_PATH="/tmp/a2wave-group-campaign.json",A2WAVE_GROUP_NAME="campaign_MCP"},tool_timeout_sec=660}',
    )
    // 两条路径都在、没有互相覆盖（旧 bug：只剩最后一个）
    expect(configOverride).toContain('/tmp/a2wave-group-plutomall.json')
    expect(configOverride).toContain('/tmp/a2wave-group-campaign.json')
    // public 变量被 inline，不进共享进程环境（不再有同名覆盖的可能）
    expect(env.A2WAVE_GROUP_CONFIG_PATH).toBeUndefined()
    expect(env.A2WAVE_GROUP_NAME).toBeUndefined()
  })

  it('public 走 inline env、secret 仍走 env_vars 且不落命令行', async () => {
    const { configOverride, env } = buildCodexMcpInjection([
      {
        name: 'plutomall_MCP',
        type: 'stdio',
        command: 'node',
        args: [],
        env: {
          A2WAVE_GROUP_CONFIG_PATH: '/tmp/a2wave-group-plutomall.json',
          SECRET_TOKEN: 'topsecret',
        },
        publicEnvKeys: ['A2WAVE_GROUP_CONFIG_PATH'],
      },
    ])
    // 非敏感路径 inline
    expect(configOverride).toContain(
      'env={A2WAVE_GROUP_CONFIG_PATH="/tmp/a2wave-group-plutomall.json"}',
    )
    // secret 只以变量名出现在 env_vars，值不在命令行
    expect(configOverride).toContain('env_vars=["SECRET_TOKEN"]')
    expect(configOverride).not.toContain('topsecret')
    // secret 值通过子进程环境传递；inline 的 public 变量不进共享环境
    expect(env.SECRET_TOKEN).toBe('topsecret')
    expect(env.A2WAVE_GROUP_CONFIG_PATH).toBeUndefined()
  })

  it('无 publicEnvKeys 的普通 stdio：行为不变，仍全走 env_vars', async () => {
    const { configOverride, env } = buildCodexMcpInjection([
      {
        name: 'my-server',
        type: 'stdio',
        command: 'node',
        args: ['server.js'],
        env: { API_KEY: 'secret' },
      },
    ])
    expect(configOverride).toBe(
      'mcp_servers={my-server={command="node",args=["server.js"],env_vars=["API_KEY"],tool_timeout_sec=660}}',
    )
    expect(configOverride).not.toContain('secret')
    expect(env.API_KEY).toBe('secret')
  })
})
