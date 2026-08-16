import { EventEmitter } from 'node:events'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockSpawn = vi.hoisted(() => vi.fn())
const mockExecFileSync = vi.hoisted(() => vi.fn())
const mockDnsLookup = vi.hoisted(() => vi.fn())
const mockUndiciAgentConstructor = vi.hoisted(() => vi.fn())
const mockUndiciAgentClose = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))

vi.mock('../cli-spawn.js', () => ({ spawnCli: mockSpawn }))

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
  execFileSync: mockExecFileSync,
  spawn: mockSpawn,
}))
vi.mock('node:dns/promises', () => ({
  lookup: (...args: unknown[]) => mockDnsLookup(...args),
}))
vi.mock('undici', () => ({
  Agent: class {
    close = mockUndiciAgentClose

    constructor(options: unknown) {
      mockUndiciAgentConstructor(options)
    }
  },
}))

vi.mock('../../env.js', () => ({
  env: {
    TRUSTED_IMPORT_HOSTS: '',
    TRUSTED_PROVIDER_HOSTS: 'trusted-provider.example.com',
  },
}))

import { ClaudeCodeEngine } from '../claude-code.js'
import { CodexAgentEngine } from '../codex-agent.js'
import { CursorAgentEngine } from '../cursor-agent.js'

class MockChildProcess extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  pid = 99999
  kill = vi.fn()
}

function settle(child: MockChildProcess, stdout: string, exitCode = 0, stderr = '') {
  child.stdout.write(stdout)
  child.stdout.end()
  if (stderr) {
    child.stderr.write(stderr)
  }
  child.stderr.end()
  child.emit('close', exitCode)
}

afterEach(() => {
  vi.clearAllMocks()
})

// ============================================================
// CursorAgentEngine.listAvailableModels
// ============================================================
describe('CursorAgentEngine.listAvailableModels', () => {
  const engine = new CursorAgentEngine({
    apiKey: '',
    timeoutMinutes: 5,
    agentForce: false,
    approveMcps: true,
    defaultWorkDir: '/tmp',
  })

  it('apiKey mode: parses each line as a model id (legacy bare-id format)', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const promise = engine.listAvailableModels({ authMode: 'apiKey', apiKey: 'key-xxx' })
    settle(child, 'composer-1\ncomposer-1.5\ngpt-5.2\ngrok\n', 0)
    const result = await promise
    expect(result.models).toEqual(['composer-1', 'composer-1.5', 'gpt-5.2', 'grok'])
    expect(result.error).toBeUndefined()
  })

  it('apiKey mode: parses CLI 2026.05+ "<id> - <desc>" output format', async () => {
    // 实测 cursor-agent 2026.05.20-2b5dd59 在 ECS 容器内的真实 stdout
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const promise = engine.listAvailableModels({ authMode: 'localSession' })
    const realStdout = [
      'Available models',
      '',
      'auto - Auto',
      'composer-2-fast - Composer 2 Fast',
      'composer-2 - Composer 2',
      'gpt-5.3-codex-low - Codex 5.3 Low',
      'gpt-5.3-codex-low-fast - Codex 5.3 Low Fast',
      'gpt-5.3-codex - Codex 5.3',
      'gpt-5.3-codex-fast - Codex 5.3 Fast',
      'gpt-5.3-codex-high - Codex 5.3 High',
      'claude-opus-4-7 - Claude Opus 4.7',
      'claude-sonnet-4-6 - Claude Sonnet 4.6',
      'gemini-3-pro - Gemini 3 Pro',
      '',
    ].join('\n')
    settle(child, realStdout, 0)
    const result = await promise
    expect(result.error).toBeUndefined()
    expect(result.models).toEqual([
      'auto',
      'composer-2-fast',
      'composer-2',
      'gpt-5.3-codex-low',
      'gpt-5.3-codex-low-fast',
      'gpt-5.3-codex',
      'gpt-5.3-codex-fast',
      'gpt-5.3-codex-high',
      'claude-opus-4-7',
      'claude-sonnet-4-6',
      'gemini-3-pro',
    ])
  })

  it('apiKey mode: injects CURSOR_API_KEY env into spawn', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const promise = engine.listAvailableModels({ authMode: 'apiKey', apiKey: 'secret-key-123' })
    settle(child, 'composer-1\n', 0)
    await promise
    const spawnCall = mockSpawn.mock.calls[0]
    const spawnOpts = spawnCall?.[2] as { env: Record<string, string> }
    expect(spawnOpts.env.CURSOR_API_KEY).toBe('secret-key-123')
  })

  it('localSession mode: does not inject CURSOR_API_KEY', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const promise = engine.listAvailableModels({ authMode: 'localSession' })
    settle(child, 'composer-1\n', 0)
    await promise
    const spawnCall = mockSpawn.mock.calls[0]
    const spawnOpts = spawnCall?.[2] as { env: Record<string, string | undefined> }
    // env 不应被覆盖（应为 process.env 直接传入）
    expect(spawnOpts.env.CURSOR_API_KEY).toBe(process.env.CURSOR_API_KEY)
  })

  it('returns no_account_models when output says "No models available"', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const promise = engine.listAvailableModels({ authMode: 'localSession' })
    settle(child, 'No models available for this account.\n', 0)
    const result = await promise
    expect(result.models).toEqual([])
    expect(result.code).toBe('no_account_models')
    expect(result.error).toMatch(/No models available/)
  })

  it('returns unsupported_mode for oauth', async () => {
    const result = await engine.listAvailableModels({
      authMode: 'oauth',
      oauthToken: 'token-xxx',
    })
    expect(result.code).toBe('unsupported_mode')
    expect(mockSpawn).not.toHaveBeenCalled()
  })

  it('returns invalid_input when apiKey missing in apiKey mode', async () => {
    const result = await engine.listAvailableModels({ authMode: 'apiKey' })
    expect(result.code).toBe('invalid_input')
    expect(mockSpawn).not.toHaveBeenCalled()
  })

  it('returns cli_failed when exit code != 0', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const promise = engine.listAvailableModels({ authMode: 'apiKey', apiKey: 'key-xxx' })
    settle(child, '', 1, 'auth error\n')
    const result = await promise
    expect(result.code).toBe('cli_failed')
  })

  it('returns spawn_failed when CLI binary not found', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const promise = engine.listAvailableModels({ authMode: 'apiKey', apiKey: 'key-xxx' })
    queueMicrotask(() => {
      const err = new Error('spawn ENOENT')
      ;(err as NodeJS.ErrnoException).code = 'ENOENT'
      child.emit('error', err)
    })
    const result = await promise
    expect(result.code).toBe('spawn_failed')
  })

  it('strips ANSI escape codes from output', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const promise = engine.listAvailableModels({ authMode: 'apiKey', apiKey: 'key-xxx' })
    // 模拟有 ANSI loading 提示 + 真实数据
    settle(child, '\x1b[2KLoading...\x1b[1A\x1b[2Kcomposer-1\ncomposer-1.5\n', 0)
    const result = await promise
    // Loading 行因含 "..." 字符被过滤；composer-* 保留
    expect(result.models).toContain('composer-1')
    expect(result.models).toContain('composer-1.5')
  })
})

// ============================================================
// CodexAgentEngine.listAvailableModels
// ============================================================
describe('CodexAgentEngine.listAvailableModels', () => {
  const engine = new CodexAgentEngine({
    path: 'codex',
    apiKey: '',
    timeoutMinutes: 5,
    force: false,
    approveMcps: true,
    defaultWorkDir: '/tmp',
  })

  it('parses JSON catalog and filters visibility=list', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const catalog = JSON.stringify({
      models: [
        { slug: 'gpt-5.5', visibility: 'list', display_name: 'GPT-5.5' },
        { slug: 'gpt-5.4', visibility: 'list' },
        { slug: 'codex-auto-review', visibility: 'hide' },
      ],
    })
    const promise = engine.listAvailableModels({ authMode: 'apiKey' })
    settle(child, catalog, 0)
    const result = await promise
    expect(result.models).toEqual(['gpt-5.5', 'gpt-5.4'])
    expect(result.error).toBeUndefined()
  })

  it('localSession mode: same behavior as apiKey (zero-cred)', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const catalog = JSON.stringify({ models: [{ slug: 'gpt-5.5', visibility: 'list' }] })
    const promise = engine.listAvailableModels({ authMode: 'localSession' })
    settle(child, catalog, 0)
    const result = await promise
    expect(result.models).toEqual(['gpt-5.5'])
  })

  it('returns unsupported_mode for oauth', async () => {
    const result = await engine.listAvailableModels({
      authMode: 'oauth',
      oauthToken: 'token-xxx',
    })
    expect(result.code).toBe('unsupported_mode')
    expect(mockSpawn).not.toHaveBeenCalled()
  })

  it('returns parse_failed on malformed JSON', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const promise = engine.listAvailableModels({ authMode: 'apiKey' })
    settle(child, 'not valid json{', 0)
    const result = await promise
    expect(result.code).toBe('parse_failed')
  })

  it('returns parse_failed when no visible models', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const catalog = JSON.stringify({
      models: [{ slug: 'hidden-thing', visibility: 'hide' }],
    })
    const promise = engine.listAvailableModels({ authMode: 'apiKey' })
    settle(child, catalog, 0)
    const result = await promise
    expect(result.code).toBe('parse_failed')
  })
})

// ============================================================
// ClaudeCodeEngine.listAvailableModels (HTTP)
// ============================================================
describe('ClaudeCodeEngine.listAvailableModels', () => {
  const engine = new ClaudeCodeEngine({
    path: 'claude',
    apiKey: '',
    baseUrl: '',
    timeoutMinutes: 5,
    force: false,
    approveMcps: true,
    defaultWorkDir: '/tmp',
  })

  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    mockDnsLookup.mockReset()
    mockDnsLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }])
    mockUndiciAgentConstructor.mockClear()
    mockUndiciAgentClose.mockClear()
    fetchSpy = vi.spyOn(globalThis, 'fetch')
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  function mockFetchOk(body: unknown) {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
  }

  function mockFetchError(status: number, body = 'upstream error') {
    fetchSpy.mockResolvedValue(new Response(body, { status }))
  }

  it('apiKey mode: hits ${userBaseUrl}/v1/models with x-api-key', async () => {
    mockFetchOk({
      data: [
        { id: 'claude-opus-4-7' },
        { id: 'claude-sonnet-4-6' },
        { id: 'claude-haiku-4-5-20251001' },
      ],
    })
    const result = await engine.listAvailableModels({
      authMode: 'apiKey',
      baseUrl: 'https://llm-proxy.example.com',
      apiKey: 'sk-xxx',
    })
    expect(result.models).toEqual([
      'claude-opus-4-7',
      'claude-sonnet-4-6',
      'claude-haiku-4-5-20251001',
    ])
    const call = fetchSpy.mock.calls[0]
    expect(call?.[0]).toBe('https://llm-proxy.example.com/v1/models')
    const headers = (call?.[1] as RequestInit)?.headers as Record<string, string>
    expect(headers['x-api-key']).toBe('sk-xxx')
    expect(headers.Authorization).toBeUndefined()
    expect(headers['anthropic-version']).toBe('2023-06-01')
  })

  it('apiKey mode: keeps an opaque legacy key on x-api-key by default', async () => {
    mockFetchOk({ data: [{ id: 'deepseek-v4-flash' }] })

    const result = await engine.listAvailableModels({
      authMode: 'apiKey',
      baseUrl: 'https://llm-proxy.example.com/hdp/v1',
      apiKey: 'opaque-legacy-key',
    })

    expect(result.models).toEqual(['deepseek-v4-flash'])
    const headers = (fetchSpy.mock.calls[0]?.[1] as RequestInit)?.headers as Record<string, string>
    expect(headers['x-api-key']).toBe('opaque-legacy-key')
    expect(headers.Authorization).toBeUndefined()
  })

  it('apiKey mode: uses Bearer auth only when explicitly configured', async () => {
    mockFetchOk({ data: [{ id: 'deepseek-v4-flash' }] })

    const result = await engine.listAvailableModels({
      authMode: 'apiKey',
      authHeaderStyle: 'bearer',
      baseUrl: 'https://llm-proxy.example.com/hdp/v1',
      apiKey: 'opaque-proxy-token',
    })

    expect(result.models).toEqual(['deepseek-v4-flash'])
    const call = fetchSpy.mock.calls[0]
    expect(call?.[0]).toBe('https://llm-proxy.example.com/hdp/v1/models')
    const headers = (call?.[1] as RequestInit)?.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer opaque-proxy-token')
    expect(headers['x-api-key']).toBeUndefined()
    expect(headers['anthropic-beta']).toBeUndefined()
  })

  it('oauth mode: allows private DNS for api.anthropic.com and uses Bearer auth', async () => {
    // OAuth tokens require Authorization: Bearer; Anthropic rejects x-api-key with 401.
    mockDnsLookup.mockResolvedValue([{ address: '10.0.0.5', family: 4 }])
    mockFetchOk({ data: [{ id: 'claude-opus-4-7' }] })
    const result = await engine.listAvailableModels({
      authMode: 'oauth',
      oauthToken: 'sk-ant-oat01-abc',
    })
    expect(result.models).toEqual(['claude-opus-4-7'])
    const call = fetchSpy.mock.calls[0]
    expect(call?.[0]).toBe('https://api.anthropic.com/v1/models')
    const headers = (call?.[1] as RequestInit)?.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer sk-ant-oat01-abc')
    expect(headers['anthropic-beta']).toBe('oauth-2025-04-20')
    expect(headers['x-api-key']).toBeUndefined()
    expect(headers['anthropic-version']).toBe('2023-06-01')
  })

  it('oauth mode: returns every pinned address when the connector requests all DNS answers', async () => {
    const addresses = [
      { address: '10.0.0.5', family: 4 },
      { address: 'fd00::5', family: 6 },
    ]
    mockDnsLookup.mockResolvedValue(addresses)
    mockFetchOk({ data: [{ id: 'claude-opus-4-7' }] })

    await engine.listAvailableModels({
      authMode: 'oauth',
      oauthToken: 'sk-ant-oat01-abc',
    })

    const connectOptions = mockUndiciAgentConstructor.mock.calls[0]?.[0] as {
      connect: {
        lookup: (
          hostname: string,
          options: { all: true },
          callback: (error: null, addresses: Array<{ address: string; family: number }>) => void,
        ) => void
      }
    }
    const lookupCallback = vi.fn()
    connectOptions.connect.lookup('api.anthropic.com', { all: true }, lookupCallback)

    expect(lookupCallback).toHaveBeenCalledWith(null, addresses)
  })

  it('apiKey mode: does not inherit private DNS trust for api.anthropic.com', async () => {
    mockDnsLookup.mockResolvedValue([{ address: '10.0.0.5', family: 4 }])

    const result = await engine.listAvailableModels({
      authMode: 'apiKey',
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'sk-ant-api03-abc',
    })

    expect(result.models).toEqual([])
    expect(result.error).toContain('private or reserved')
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(mockUndiciAgentConstructor).not.toHaveBeenCalled()
  })

  it('apiKey mode with an OAuth-shaped token still defaults to x-api-key', async () => {
    mockFetchOk({ data: [{ id: 'claude-opus-4-7' }] })
    await engine.listAvailableModels({
      authMode: 'apiKey',
      baseUrl: 'https://proxy.example.com',
      apiKey: 'sk-ant-oat01-xxx',
    })
    const call = fetchSpy.mock.calls[0]
    const headers = (call?.[1] as RequestInit)?.headers as Record<string, string>
    expect(headers['x-api-key']).toBe('sk-ant-oat01-xxx')
    expect(headers.Authorization).toBeUndefined()
    expect(headers['anthropic-beta']).toBeUndefined()
  })

  it('apiKey mode with an OAuth-shaped token honors explicit Bearer without OAuth beta', async () => {
    mockFetchOk({ data: [{ id: 'claude-opus-4-7' }] })
    await engine.listAvailableModels({
      authMode: 'apiKey',
      authHeaderStyle: 'bearer',
      baseUrl: 'https://proxy.example.com',
      apiKey: 'sk-ant-oat01-xxx',
    })
    const headers = (fetchSpy.mock.calls[0]?.[1] as RequestInit)?.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer sk-ant-oat01-xxx')
    expect(headers['x-api-key']).toBeUndefined()
    expect(headers['anthropic-beta']).toBeUndefined()
  })

  it('apiKey mode: strips trailing /v1 to avoid /v1/v1/models', async () => {
    // 实测踩坑：用户填 baseUrl 末尾带 /v1（与 ANTHROPIC_BASE_URL 习惯一致），
    // 但 engine 会再补 /v1/models —— 必须幂等剥 /v1。
    mockFetchOk({ data: [{ id: 'claude-opus-4-7' }] })
    await engine.listAvailableModels({
      authMode: 'apiKey',
      baseUrl: 'https://llm-proxy.example.com/v1',
      apiKey: 'sk-xxx',
    })
    const call = fetchSpy.mock.calls[0]
    expect(call?.[0]).toBe('https://llm-proxy.example.com/v1/models')
  })

  it('apiKey mode: strips trailing /v1/ (with slash) too', async () => {
    mockFetchOk({ data: [{ id: 'claude-opus-4-7' }] })
    await engine.listAvailableModels({
      authMode: 'apiKey',
      baseUrl: 'https://llm-proxy.example.com/v1/',
      apiKey: 'sk-xxx',
    })
    const call = fetchSpy.mock.calls[0]
    expect(call?.[0]).toBe('https://llm-proxy.example.com/v1/models')
  })

  it('does not follow redirects from the pinned endpoint to cloud metadata', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: 'http://169.254.169.254/latest/meta-data' },
      }),
    )

    const result = await engine.listAvailableModels({
      authMode: 'apiKey',
      baseUrl: 'https://proxy.example.com',
      apiKey: 'sk-xxx',
    })

    expect(result.models).toEqual([])
    expect(result.error).toContain('Too many redirects')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('rejects a Provider hostname that resolves to a private address before fetch', async () => {
    mockDnsLookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }])

    const result = await engine.listAvailableModels({
      authMode: 'apiKey',
      baseUrl: 'https://provider-proxy.example.com',
      apiKey: 'sk-xxx',
    })

    expect(result.models).toEqual([])
    expect(result.error).toContain('private or reserved')
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(mockUndiciAgentConstructor).not.toHaveBeenCalled()
  })

  it('allows and pins a private address for a configured trusted Provider hostname', async () => {
    mockDnsLookup.mockResolvedValue([{ address: '10.0.0.5', family: 4 }])
    mockFetchOk({ data: [{ id: 'private-model' }] })

    const result = await engine.listAvailableModels({
      authMode: 'apiKey',
      baseUrl: 'https://trusted-provider.example.com',
      apiKey: 'sk-xxx',
    })

    expect(result.models).toEqual(['private-model'])
    const connectOptions = mockUndiciAgentConstructor.mock.calls[0]?.[0] as {
      connect: {
        lookup: (
          hostname: string,
          options: unknown,
          callback: (error: null, address: string, family: number) => void,
        ) => void
      }
    }
    const lookupCallback = vi.fn()
    connectOptions.connect.lookup('trusted-provider.example.com', {}, lookupCallback)
    expect(lookupCallback).toHaveBeenCalledWith(null, '10.0.0.5', 4)
  })

  it('pins the validated public address and disables redirects', async () => {
    mockFetchOk({ data: [{ id: 'claude-opus-4-7' }] })

    const result = await engine.listAvailableModels({
      authMode: 'apiKey',
      baseUrl: 'https://provider-proxy.example.com',
      apiKey: 'sk-xxx',
    })

    expect(result.models).toEqual(['claude-opus-4-7'])
    expect(mockUndiciAgentConstructor).toHaveBeenCalledTimes(1)
    const connectOptions = mockUndiciAgentConstructor.mock.calls[0]?.[0] as {
      connect: {
        lookup: (
          hostname: string,
          options: unknown,
          callback: (error: null, address: string, family: number) => void,
        ) => void
      }
    }
    const lookupCallback = vi.fn()
    connectOptions.connect.lookup('provider-proxy.example.com', {}, lookupCallback)
    expect(lookupCallback).toHaveBeenCalledWith(null, '93.184.216.34', 4)
    expect(fetchSpy.mock.calls[0]?.[1]).toHaveProperty('dispatcher')
    expect(mockUndiciAgentClose).toHaveBeenCalledTimes(1)
  })

  it('does not follow redirects after pinning the Provider endpoint', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: 'https://other-public.example/v1/models' },
      }),
    )

    const result = await engine.listAvailableModels({
      authMode: 'apiKey',
      baseUrl: 'https://provider-proxy.example.com',
      apiKey: 'sk-xxx',
    })

    expect(result.error).toContain('Too many redirects')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(mockUndiciAgentClose).toHaveBeenCalledTimes(1)
  })

  describe('localSession mode', () => {
    let fakeHome: string
    let origHome: string | undefined
    let origUserProfile: string | undefined
    let origConfigDir: string | undefined

    beforeEach(() => {
      fakeHome = mkdtempSync(join(tmpdir(), 'a2wave-claude-cred-test-'))
      origHome = process.env.HOME
      origUserProfile = process.env.USERPROFILE
      origConfigDir = process.env.CLAUDE_CONFIG_DIR
      process.env.HOME = fakeHome
      process.env.USERPROFILE = fakeHome
      Reflect.deleteProperty(process.env, 'CLAUDE_CONFIG_DIR')
    })

    afterEach(() => {
      if (origHome === undefined) Reflect.deleteProperty(process.env, 'HOME')
      else process.env.HOME = origHome
      if (origUserProfile === undefined) Reflect.deleteProperty(process.env, 'USERPROFILE')
      else process.env.USERPROFILE = origUserProfile
      if (origConfigDir === undefined) Reflect.deleteProperty(process.env, 'CLAUDE_CONFIG_DIR')
      else process.env.CLAUDE_CONFIG_DIR = origConfigDir
      rmSync(fakeHome, { recursive: true, force: true })
    })

    function writeCred(content: string) {
      const dir = join(fakeHome, '.claude')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, '.credentials.json'), content)
    }

    it('returns local_session_not_logged_in when credentials file missing', async () => {
      const result = await engine.listAvailableModels({ authMode: 'localSession' })
      expect(result.code).toBe('local_session_not_logged_in')
      expect(result.models).toEqual([])
      expect(fetchSpy).not.toHaveBeenCalled()
    })

    it('returns local_session_invalid_format on malformed JSON', async () => {
      writeCred('{ this is not json')
      const result = await engine.listAvailableModels({ authMode: 'localSession' })
      expect(result.code).toBe('local_session_invalid_format')
      expect(fetchSpy).not.toHaveBeenCalled()
    })

    it('returns local_session_invalid_format when accessToken missing', async () => {
      writeCred(JSON.stringify({ claudeAiOauth: {} }))
      const result = await engine.listAvailableModels({ authMode: 'localSession' })
      expect(result.code).toBe('local_session_invalid_format')
      expect(fetchSpy).not.toHaveBeenCalled()
    })

    it('returns local_session_invalid_format when claudeAiOauth missing', async () => {
      writeCred(JSON.stringify({ somethingElse: 'foo' }))
      const result = await engine.listAvailableModels({ authMode: 'localSession' })
      expect(result.code).toBe('local_session_invalid_format')
      expect(fetchSpy).not.toHaveBeenCalled()
    })

    it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
      'returns local_session_read_failed when readFileSync throws (e.g. EACCES)',
      async () => {
        // chmod(000) produces a real EACCES only for a non-root POSIX process.
        writeCred(JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-x' } }))
        const credPath = join(fakeHome, '.claude', '.credentials.json')
        chmodSync(credPath, 0o000)
        try {
          const result = await engine.listAvailableModels({ authMode: 'localSession' })
          expect(result.code).toBe('local_session_read_failed')
          expect(result.error).toMatch(/EACCES|permission/i)
          expect(fetchSpy).not.toHaveBeenCalled()
        } finally {
          // Restore access so afterEach can remove the temporary directory.
          chmodSync(credPath, 0o600)
        }
      },
    )

    it('probes /v1/models with Bearer when credentials present', async () => {
      writeCred(JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-localtest' } }))
      mockFetchOk({ data: [{ id: 'claude-opus-4-7' }, { id: 'claude-sonnet-4-6' }] })

      const result = await engine.listAvailableModels({ authMode: 'localSession' })

      expect(result.code).toBeUndefined()
      expect(result.models).toEqual(['claude-opus-4-7', 'claude-sonnet-4-6'])
      const call = fetchSpy.mock.calls[0]
      expect(call?.[0]).toBe('https://api.anthropic.com/v1/models')
      const headers = (call?.[1] as RequestInit)?.headers as Record<string, string>
      expect(headers.Authorization).toBe('Bearer sk-ant-oat01-localtest')
      expect(headers['x-api-key']).toBeUndefined()
    })

    it('honors CLAUDE_CONFIG_DIR env override', async () => {
      const customDir = mkdtempSync(join(tmpdir(), 'a2wave-claude-cfgdir-test-'))
      try {
        writeFileSync(
          join(customDir, '.credentials.json'),
          JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-fromcfgdir' } }),
        )
        process.env.CLAUDE_CONFIG_DIR = customDir
        mockFetchOk({ data: [{ id: 'claude-opus-4-7' }] })

        const result = await engine.listAvailableModels({ authMode: 'localSession' })

        expect(result.models).toEqual(['claude-opus-4-7'])
        const headers = (fetchSpy.mock.calls[0]?.[1] as RequestInit)?.headers as Record<
          string,
          string
        >
        expect(headers.Authorization).toBe('Bearer sk-ant-oat01-fromcfgdir')
      } finally {
        rmSync(customDir, { recursive: true, force: true })
      }
    })

    // macOS Keychain fallback：claude CLI 在 mac 上把凭证存 Keychain 不写文件
    describe('macOS Keychain fallback', () => {
      let origPlatform: PropertyDescriptor | undefined

      beforeEach(() => {
        // 强制设 platform = 'darwin' 测试 fallback 分支
        origPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
        Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
        mockExecFileSync.mockReset()
      })

      afterEach(() => {
        if (origPlatform) {
          Object.defineProperty(process, 'platform', origPlatform)
        }
      })

      it('falls back to security command on darwin when file missing', async () => {
        // 用 keychain 返回合法 JSON
        mockExecFileSync.mockReturnValue(
          `${JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-keychain' } })}\n`,
        )
        mockFetchOk({ data: [{ id: 'claude-opus-4-8' }] })

        const result = await engine.listAvailableModels({ authMode: 'localSession' })

        expect(result.code).toBeUndefined()
        expect(result.models).toEqual(['claude-opus-4-8'])
        expect(mockExecFileSync).toHaveBeenCalledWith(
          'security',
          ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
          expect.objectContaining({ timeout: 5_000, encoding: 'utf-8' }),
        )
        const headers = (fetchSpy.mock.calls[0]?.[1] as RequestInit)?.headers as Record<
          string,
          string
        >
        expect(headers.Authorization).toBe('Bearer sk-ant-oat01-keychain')
      })

      it('returns local_session_not_logged_in when keychain command fails', async () => {
        mockExecFileSync.mockImplementation(() => {
          throw new Error(
            'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.',
          )
        })

        const result = await engine.listAvailableModels({ authMode: 'localSession' })

        expect(result.code).toBe('local_session_not_logged_in')
        expect(result.error).toContain('macOS Keychain')
        expect(fetchSpy).not.toHaveBeenCalled()
      })

      it('returns local_session_invalid_format when keychain returns malformed JSON', async () => {
        mockExecFileSync.mockReturnValue('not-json-output\n')

        const result = await engine.listAvailableModels({ authMode: 'localSession' })

        expect(result.code).toBe('local_session_invalid_format')
        expect(fetchSpy).not.toHaveBeenCalled()
      })

      it('returns local_session_invalid_format when keychain JSON lacks accessToken', async () => {
        mockExecFileSync.mockReturnValue(`${JSON.stringify({ claudeAiOauth: {} })}\n`)

        const result = await engine.listAvailableModels({ authMode: 'localSession' })

        expect(result.code).toBe('local_session_invalid_format')
        expect(fetchSpy).not.toHaveBeenCalled()
      })

      it('prefers credentials file when it exists (skips keychain fallback)', async () => {
        // 文件存在时不应该调 keychain
        writeCred(JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-fromfile' } }))
        mockFetchOk({ data: [{ id: 'claude-opus-4-8' }] })

        const result = await engine.listAvailableModels({ authMode: 'localSession' })

        expect(result.models).toEqual(['claude-opus-4-8'])
        expect(mockExecFileSync).not.toHaveBeenCalled()
        const headers = (fetchSpy.mock.calls[0]?.[1] as RequestInit)?.headers as Record<
          string,
          string
        >
        expect(headers.Authorization).toBe('Bearer sk-ant-oat01-fromfile')
      })
    })
  })

  it('returns invalid_input when apiKey missing', async () => {
    const result = await engine.listAvailableModels({
      authMode: 'apiKey',
      baseUrl: 'https://api.anthropic.com',
    })
    expect(result.code).toBe('invalid_input')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('returns invalid_input when baseUrl missing in apiKey mode', async () => {
    const result = await engine.listAvailableModels({ authMode: 'apiKey', apiKey: 'sk-xxx' })
    expect(result.code).toBe('invalid_input')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('returns invalid_input when oauthToken missing in oauth mode', async () => {
    const result = await engine.listAvailableModels({ authMode: 'oauth' })
    expect(result.code).toBe('invalid_input')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('returns http_error on 4xx upstream', async () => {
    mockFetchError(401, '{"error": "unauthorized"}')
    const result = await engine.listAvailableModels({
      authMode: 'apiKey',
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'bad-key',
    })
    expect(result.code).toBe('http_error')
    expect(result.details?.status).toBe(401)
    expect(result.details?.body).toContain('unauthorized')
  })

  it('handles trailing slash on baseUrl', async () => {
    mockFetchOk({ data: [{ id: 'claude-opus-4-7' }] })
    await engine.listAvailableModels({
      authMode: 'apiKey',
      baseUrl: 'https://api.anthropic.com/',
      apiKey: 'sk-xxx',
    })
    const call = fetchSpy.mock.calls[0]
    expect(call?.[0]).toBe('https://api.anthropic.com/v1/models')
  })

  it('filters non-string model ids', async () => {
    mockFetchOk({
      data: [
        { id: 'claude-opus-4-7' },
        { id: null },
        { id: '' },
        { something: 'else' },
        { id: 'claude-sonnet-4-6' },
      ],
    })
    const result = await engine.listAvailableModels({
      authMode: 'apiKey',
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'sk-xxx',
    })
    expect(result.models).toEqual(['claude-opus-4-7', 'claude-sonnet-4-6'])
  })
})

// ============================================================
// Reasoning-effort discovery
//
// The level set is a property of the MODEL, not of the Provider: codex
// advertises `ultra`, Claude never does; Claude Opus 4.5 has neither `xhigh`
// nor `max`; Haiku 4.5 accepts no effort at all. These tests pin that the
// levels travel with the model id rather than being inferred from the kind.
// ============================================================
describe('reasoning effort discovery', () => {
  const claude = new ClaudeCodeEngine({
    path: 'claude',
    apiKey: '',
    baseUrl: '',
    timeoutMinutes: 5,
    force: false,
    approveMcps: true,
    defaultWorkDir: '/tmp',
  })
  const codex = new CodexAgentEngine({
    path: 'codex',
    apiKey: '',
    timeoutMinutes: 5,
    force: false,
    approveMcps: true,
    defaultWorkDir: '/tmp',
  })

  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    mockDnsLookup.mockReset()
    mockDnsLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }])
    fetchSpy = vi.spyOn(globalThis, 'fetch')
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  function mockModelsResponse(body: unknown) {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
  }

  it('claude-code: carries the levels each model reports, and they differ per model', async () => {
    mockModelsResponse({
      data: [
        {
          id: 'claude-opus-4-8',
          capabilities: {
            effort: {
              supported: true,
              low: { supported: true },
              medium: { supported: true },
              high: { supported: true },
              xhigh: { supported: true },
              max: { supported: true },
            },
          },
        },
        {
          id: 'claude-opus-4-5-20251101',
          capabilities: {
            effort: {
              supported: true,
              low: { supported: true },
              medium: { supported: true },
              high: { supported: true },
              xhigh: { supported: false },
              max: { supported: false },
            },
          },
        },
      ],
    })

    const result = await claude.listAvailableModels({
      authMode: 'oauth',
      oauthToken: 'sk-ant-oat01-abc',
    })

    expect(result.models).toEqual(['claude-opus-4-8', 'claude-opus-4-5-20251101'])
    expect(result.modelCapabilities?.['claude-opus-4-8']?.reasoningEfforts).toEqual([
      { value: 'low' },
      { value: 'medium' },
      { value: 'high' },
      { value: 'xhigh' },
      { value: 'max' },
    ])
    expect(
      result.modelCapabilities?.['claude-opus-4-5-20251101']?.reasoningEfforts?.map(
        (option) => option.value,
      ),
    ).toEqual(['low', 'medium', 'high'])
  })

  it('claude-code: reports an empty level list for a model that supports no effort', async () => {
    mockModelsResponse({
      data: [{ id: 'claude-haiku-4-5-20251001', capabilities: { effort: { supported: false } } }],
    })

    const result = await claude.listAvailableModels({
      authMode: 'oauth',
      oauthToken: 'sk-ant-oat01-abc',
    })

    // Empty, not absent: discovery answered the question, and the answer was "none".
    expect(result.modelCapabilities?.['claude-haiku-4-5-20251001']?.reasoningEfforts).toEqual([])
  })

  it('claude-code: leaves capabilities unknown when a proxy returns bare model ids', async () => {
    mockModelsResponse({ data: [{ id: 'deepseek-v4-flash' }, { id: 'internal-model' }] })

    const result = await claude.listAvailableModels({
      authMode: 'apiKey',
      baseUrl: 'https://llm-proxy.example.com',
      apiKey: 'sk-xxx',
    })

    expect(result.models).toEqual(['deepseek-v4-flash', 'internal-model'])
    // Unknown must not be reported as "no levels" — the UI treats the two differently.
    expect(result.modelCapabilities).toBeUndefined()
  })

  it('codex: carries levels, their descriptions and the model default', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const catalog = JSON.stringify({
      models: [
        {
          slug: 'gpt-5.6-sol',
          visibility: 'list',
          default_reasoning_level: 'low',
          supported_reasoning_levels: [
            { effort: 'low', description: 'Fast responses with lighter reasoning' },
            { effort: 'ultra', description: 'Maximum reasoning with automatic task delegation' },
          ],
        },
      ],
    })

    const promise = codex.listAvailableModels({ authMode: 'apiKey' })
    settle(child, catalog, 0)
    const result = await promise

    expect(result.models).toEqual(['gpt-5.6-sol'])
    expect(result.modelCapabilities?.['gpt-5.6-sol']).toEqual({
      reasoningEfforts: [
        { value: 'low', description: 'Fast responses with lighter reasoning' },
        { value: 'ultra', description: 'Maximum reasoning with automatic task delegation' },
      ],
      defaultReasoningEffort: 'low',
    })
  })

  it('codex: omits an entry for a model that reports no reasoning metadata', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const catalog = JSON.stringify({
      models: [{ slug: 'gpt-5.6-sol', visibility: 'list' }],
    })

    const promise = codex.listAvailableModels({ authMode: 'apiKey' })
    settle(child, catalog, 0)
    const result = await promise

    expect(result.models).toEqual(['gpt-5.6-sol'])
    expect(result.modelCapabilities).toBeUndefined()
  })

  it('codex: drops a level token that is not a plain lowercase word', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const catalog = JSON.stringify({
      models: [
        {
          slug: 'gpt-5.6-sol',
          visibility: 'list',
          supported_reasoning_levels: [{ effort: 'high' }, { effort: '--not-a-level' }],
        },
      ],
    })

    const promise = codex.listAvailableModels({ authMode: 'apiKey' })
    settle(child, catalog, 0)
    const result = await promise

    expect(result.modelCapabilities?.['gpt-5.6-sol']?.reasoningEfforts).toEqual([{ value: 'high' }])
  })

  it('codex: reports unknown, not "none", when every level token is unreadable', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const catalog = JSON.stringify({
      models: [
        {
          slug: 'gpt-5.6-sol',
          visibility: 'list',
          supported_reasoning_levels: [{ effort: 'Very High' }, { effort: 'MAX' }],
        },
      ],
    })

    const promise = codex.listAvailableModels({ authMode: 'apiKey' })
    settle(child, catalog, 0)
    const result = await promise

    // The CLI clearly HAS levels; this code just could not read its vocabulary.
    // An empty array would tell the operator "this model takes no reasoning
    // level" — a claim discovery never made — and grey out a usable control.
    expect(result.modelCapabilities?.['gpt-5.6-sol']).toBeUndefined()
  })

  it('codex: clips a level description to the length the schema allows', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const catalog = JSON.stringify({
      models: [
        {
          slug: 'gpt-5.6-sol',
          visibility: 'list',
          supported_reasoning_levels: [{ effort: 'high', description: 'x'.repeat(400) }],
        },
      ],
    })

    const promise = codex.listAvailableModels({ authMode: 'apiKey' })
    settle(child, catalog, 0)
    const result = await promise

    // The route returns the adapter result verbatim, so this slice is the only
    // thing keeping the payload inside `reasoningEffortOptionSchema`'s max(200).
    expect(
      result.modelCapabilities?.['gpt-5.6-sol']?.reasoningEfforts?.[0]?.description,
    ).toHaveLength(200)
  })
})

/**
 * Fast-mode eligibility is asked of an INTERNAL Anthropic endpoint, not a
 * published contract. The whole design rests on it failing OPEN: a probe that
 * cannot answer must leave the control usable, because the alternative is
 * greying out a working feature on the strength of a 404. Only a definite
 * `enabled: false` from Anthropic itself disables it.
 */
describe('claude-code fast mode eligibility probe', () => {
  const claude = new ClaudeCodeEngine({
    path: 'claude',
    apiKey: '',
    baseUrl: '',
    timeoutMinutes: 5,
    force: false,
    approveMcps: true,
    defaultWorkDir: '/tmp',
  })

  const MODELS_URL = 'https://api.anthropic.com/v1/models'
  const FAST_MODE_URL = 'https://api.anthropic.com/api/claude_code_penguin_mode'

  let fetchSpy: ReturnType<typeof vi.spyOn>
  let fastModeRequests: Array<{ url: string; headers: Headers }>

  beforeEach(() => {
    mockDnsLookup.mockReset()
    mockDnsLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }])
    fastModeRequests = []
    fetchSpy = vi.spyOn(globalThis, 'fetch')
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })

  /** Route by URL: the models call and the eligibility call hit the same spy. */
  function route(fastMode: () => Promise<Response>) {
    fetchSpy.mockImplementation(async (input: unknown, init?: unknown) => {
      const url = String(input)
      if (url.includes('claude_code_penguin_mode')) {
        fastModeRequests.push({
          url,
          headers: new Headers((init as RequestInit | undefined)?.headers),
        })
        return fastMode()
      }
      return json({ data: [{ id: 'claude-opus-4-8' }] })
    })
  }

  const probe = () => claude.listAvailableModels({ authMode: 'oauth', oauthToken: 'sk-ant-oat01' })

  it('reports the entitlement when Anthropic grants it', async () => {
    route(async () => json({ enabled: true }))

    expect((await probe()).fastMode).toEqual({ available: true })
  })

  it('carries the refusal reason, which is what the UI shows instead of a dead switch', async () => {
    route(async () => json({ enabled: false, disabled_reason: 'extra_usage_disabled' }))

    expect((await probe()).fastMode).toEqual({
      available: false,
      reason: 'extra_usage_disabled',
    })
  })

  it('clips an over-long reason rather than passing it through to the UI', async () => {
    route(async () => json({ enabled: false, disabled_reason: 'x'.repeat(200) }))

    expect((await probe()).fastMode?.reason).toHaveLength(64)
  })

  it('carries no reason when the answer is yes', async () => {
    route(async () => json({ enabled: true, disabled_reason: 'stale field' }))

    expect((await probe()).fastMode).not.toHaveProperty('reason')
  })

  it('sends the OAuth token as a bearer with the beta header the endpoint requires', async () => {
    route(async () => json({ enabled: true }))

    await probe()

    expect(fastModeRequests).toHaveLength(1)
    expect(fastModeRequests[0].headers.get('authorization')).toBe('Bearer sk-ant-oat01')
    expect(fastModeRequests[0].headers.get('anthropic-beta')).toBe('oauth-2025-04-20')
  })

  it('stays silent on a non-200 rather than reporting the feature unavailable', async () => {
    route(async () => json({ error: 'not found' }, 404))

    const result = await probe()

    // The distinction the whole probe rests on: absent means "not answered",
    // and the switch stays usable. `available: false` would grey it out.
    expect(result.fastMode).toBeUndefined()
    expect(result.models).toEqual(['claude-opus-4-8'])
  })

  it('stays silent when the body omits the field it is supposed to answer with', async () => {
    route(async () => json({ disabled_reason: 'extra_usage_disabled' }))

    expect((await probe()).fastMode).toBeUndefined()
  })

  it('stays silent when the field is present but not a boolean', async () => {
    route(async () => json({ enabled: 'true' }))

    expect((await probe()).fastMode).toBeUndefined()
  })

  it('stays silent on unparseable JSON', async () => {
    route(async () => new Response('<html>gateway</html>', { status: 200 }))

    expect((await probe()).fastMode).toBeUndefined()
  })

  it('stays silent when the request throws, and still returns the models', async () => {
    route(async () => {
      throw new Error('ECONNRESET')
    })

    const result = await probe()

    expect(result.fastMode).toBeUndefined()
    expect(result.models).toEqual(['claude-opus-4-8'])
  })

  it('stays silent when the request times out', async () => {
    route(async () => {
      throw Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' })
    })

    expect((await probe()).fastMode).toBeUndefined()
  })

  it('never asks a proxy a question only Anthropic can answer', async () => {
    route(async () => json({ enabled: true }))

    const result = await claude.listAvailableModels({
      authMode: 'apiKey',
      baseUrl: 'https://llm-proxy.example.com',
      apiKey: 'sk-xxx',
    })

    expect(fastModeRequests).toEqual([])
    expect(result.fastMode).toBeUndefined()
  })

  it('asks the entitlement endpoint, which is a different path on the same host', async () => {
    route(async () => json({ enabled: true }))

    await probe()

    expect(fastModeRequests[0].url).toBe(FAST_MODE_URL)
    expect(fastModeRequests[0].url).not.toBe(MODELS_URL)
  })
})
