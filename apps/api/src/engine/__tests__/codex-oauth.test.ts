import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cliProcessRunner } from '../cli-process-runner.js'
import { CodexAgentEngine } from '../codex-agent.js'
import { encodeCodexOAuthChatId } from '../codex-oauth-session.js'
import type { StreamExecuteRequest } from '../types.js'

const resolveCredentials = vi.hoisted(() => vi.fn())
const spawnCli = vi.hoisted(() => vi.fn())
vi.mock('../../lib/provider-oauth-accounts.js', () => ({
  resolveProviderOauthAccountCredentials: resolveCredentials,
}))
vi.mock('../cli-spawn.js', () => ({ spawnCli }))
vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

const config = {
  path: 'codex',
  apiKey: 'deployment-secret',
  timeoutMinutes: 1,
  force: false,
  approveMcps: true,
  defaultWorkDir: '/tmp',
}
class FakeChild extends EventEmitter {
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  kill = vi.fn()
  pid = 889900
}
function execute(engine: CodexAgentEngine, request: StreamExecuteRequest) {
  return (
    engine as unknown as {
      executeStreamWithModel: (r: StreamExecuteRequest, model: string) => Promise<unknown>
    }
  ).executeStreamWithModel(request, 'available-model')
}
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('Codex OAuth account execution', () => {
  it.each([
    ['untagged', 'thread-a', 'thread/start'],
    ['another account', 'foreign', 'thread/start'],
    ['same account', 'same', 'thread/resume'],
  ])('uses account-scoped history for %s input', async (_label, input, expectedMethod) => {
    resolveCredentials.mockResolvedValue({ accessToken: 'token' })
    const child = new FakeChild()
    spawnCli.mockReturnValue(child)
    const incomingChatId =
      input === 'same'
        ? encodeCodexOAuthChatId('poa_a', 'thread-a')
        : input === 'foreign'
          ? encodeCodexOAuthChatId('poa_b', 'thread-a')
          : input
    const promise = execute(new CodexAgentEngine(config), {
      taskId: `scoped-chat-${input}`,
      workDir: '/tmp',
      prompt: 'continue',
      chatId: incomingChatId,
      agentConfig: { authMode: 'oauth', providerOauthAccountId: 'poa_a' },
    })
    await vi.waitFor(() => expect(spawnCli).toHaveBeenCalledOnce())
    const messages: Record<string, unknown>[] = []
    child.stdin.on('data', (chunk) => messages.push(JSON.parse(String(chunk))))
    child.emit('spawn')
    child.stdout.write(`${JSON.stringify({ id: 1, result: {} })}\n`)
    expect(messages[2]).toMatchObject({ method: expectedMethod })
    if (expectedMethod === 'thread/resume') {
      expect(messages[2]).toMatchObject({ params: { threadId: 'thread-a' } })
    } else expect(messages[2].params).not.toHaveProperty('threadId')
    for (const message of [
      { id: 2, result: { thread: { id: 'new-thread' } } },
      { id: 3, result: { turn: { id: 'turn-a' } } },
      { method: 'turn/completed', params: { turn: { id: 'turn-a', status: 'completed' } } },
    ])
      child.stdout.write(`${JSON.stringify(message)}\n`)
    child.emit('close', 0)
    await expect(promise).resolves.toMatchObject({
      chatId: encodeCodexOAuthChatId('poa_a', 'new-thread'),
    })
  })

  it('cancels pending credential resolution and cannot spawn after late resolution', async () => {
    let resolve!: (value: { accessToken: string }) => void
    resolveCredentials.mockReturnValue(
      new Promise((done) => {
        resolve = done
      }),
    )
    const promise = execute(new CodexAgentEngine(config), {
      taskId: 'cancel-pending-auth',
      workDir: '/tmp',
      prompt: 'Must not run',
      agentConfig: { authMode: 'oauth', providerOauthAccountId: 'poa_a' },
    })
    const rejected = expect(promise).rejects.toThrow(/cancelled/)
    await vi.waitFor(() => expect(resolveCredentials).toHaveBeenCalledOnce())
    expect(await cliProcessRunner.cancelAndWait('cancel-pending-auth')).toBe(true)
    await rejected
    resolve({ accessToken: 'late-token' })
    await new Promise((done) => setTimeout(done, 0))
    expect(spawnCli).not.toHaveBeenCalled()
    expect(await cliProcessRunner.cancelAndWait('cancel-pending-auth')).toBe(false)
  })

  it('bounds pending credentials by the original execution deadline', async () => {
    vi.useFakeTimers()
    let resolve!: (value: { accessToken: string }) => void
    resolveCredentials.mockReturnValue(
      new Promise((done) => {
        resolve = done
      }),
    )
    const promise = execute(new CodexAgentEngine(config), {
      taskId: 'deadline-pending-auth',
      workDir: '/tmp',
      prompt: 'Must not run',
      agentConfig: { authMode: 'oauth', providerOauthAccountId: 'poa_a' },
    })
    const rejected = expect(promise).rejects.toThrow(/timed out/)
    await vi.advanceTimersByTimeAsync(60_000)
    await rejected
    resolve({ accessToken: 'late-token' })
    await vi.advanceTimersByTimeAsync(0)
    expect(spawnCli).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('resolves the selected account and injects only its access token into app-server', async () => {
    resolveCredentials.mockResolvedValue({ accessToken: 'fresh-account-token' })
    const child = new FakeChild()
    spawnCli.mockReturnValue(child)
    vi.stubEnv('ACCESS_TOKEN', 'host-token')
    const onLogEntry = vi.fn()
    const engine = new CodexAgentEngine(config)
    const promise = execute(engine, {
      taskId: 'oauth-test',
      workDir: '/tmp',
      prompt: 'hello',
      onLogEntry,
      agentConfig: {
        authMode: 'oauth',
        providerOauthAccountId: 'pacc_a',
        providerId: 'prv_codex',
        force: true,
        readOnly: true,
        agentEnv: { ACCESS_TOKEN: 'agent-token', OPENAI_API_KEY: 'agent-key' },
        resolvedMcpServers: [
          {
            name: 'tools',
            type: 'stdio',
            command: 'tool-server',
            env: { ACCESS_TOKEN: 'mcp-token' },
          },
        ],
      },
    })
    await vi.waitFor(() => expect(spawnCli).toHaveBeenCalledOnce())
    const [, args, options] = spawnCli.mock.calls[0]
    expect(resolveCredentials).toHaveBeenCalledWith('pacc_a', 'prv_codex', {
      minimumValidityMs: 120_000,
    })
    expect(args).toEqual(
      expect.arrayContaining([
        'app-server',
        '--listen',
        'stdio://',
        'model_provider="openai_chatgpt_plan"',
        'model_providers.openai_chatgpt_plan.env_key="ACCESS_TOKEN"',
        'model_providers.openai_chatgpt_plan.requires_openai_auth=false',
        'model_providers.openai_chatgpt_plan.supports_websockets=false',
      ]),
    )
    expect(args).not.toContain('exec')
    expect(options.env.ACCESS_TOKEN).toBe('fresh-account-token')
    expect(options.env.OPENAI_API_KEY).toBeUndefined()
    expect(options.env.CODEX_ACCESS_TOKEN).toBeUndefined()
    expect(JSON.stringify(args)).not.toContain('fresh-account-token')
    const received: Record<string, unknown>[] = []
    child.stdin.on('data', (chunk) => received.push(JSON.parse(String(chunk))))
    child.emit('spawn')
    for (const data of [
      { id: 1, result: {} },
      { id: 2, result: { thread: { id: 'thread-a' } } },
      { id: 3, result: { turn: { id: 'turn-a' } } },
      {
        method: 'item/completed',
        params: { item: { type: 'agentMessage', id: 'msg-a', text: 'done' } },
      },
      { method: 'turn/completed', params: { turn: { id: 'turn-a', status: 'completed' } } },
    ])
      child.stdout.write(`${JSON.stringify(data)}\n`)
    child.emit('close', 0)
    await expect(promise).resolves.toMatchObject({
      success: true,
      output: 'done',
      chatId: encodeCodexOAuthChatId('pacc_a', 'thread-a'),
    })
    expect(received[2]).toMatchObject({ method: 'thread/start', params: { sandbox: 'read-only' } })
    expect(received[0]).toMatchObject({
      method: 'initialize',
      params: { clientInfo: { name: 'a2wave' } },
    })
    expect(JSON.stringify(onLogEntry.mock.calls)).not.toContain('fresh-account-token')
    expect(JSON.stringify(onLogEntry.mock.calls)).not.toContain('deployment-secret')
  })

  it('refreshes once on a structured 401 and resumes the thread without resending the original prompt', async () => {
    resolveCredentials
      .mockResolvedValueOnce({ accessToken: 'old-token' })
      .mockResolvedValueOnce({ accessToken: 'renewed-token' })
    const children = [new FakeChild(), new FakeChild()]
    spawnCli.mockReturnValueOnce(children[0]).mockReturnValueOnce(children[1])
    const onLogEntry = vi.fn()
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    const run = vi.spyOn(cliProcessRunner, 'run')
    const promise = execute(new CodexAgentEngine(config), {
      taskId: 'auth-recovery',
      workDir: '/tmp',
      prompt: 'Transfer once',
      onLogEntry,
      agentConfig: { authMode: 'oauth', providerOauthAccountId: 'poa_a' },
    })
    await vi.waitFor(() => expect(spawnCli).toHaveBeenCalledTimes(1))
    const finish = (child: FakeChild, success: boolean) => {
      child.emit('spawn')
      for (const data of [
        { id: 1, result: {} },
        { id: 2, result: { thread: { id: 'thread-a' } } },
        { id: 3, result: { turn: { id: 'turn-a' } } },
        {
          method: 'thread/tokenUsage/updated',
          params: { turnId: 'turn-a', tokenUsage: { last: { inputTokens: 10, outputTokens: 2 } } },
        },
        {
          method: 'turn/completed',
          params: {
            turn: {
              id: 'turn-a',
              status: success ? 'completed' : 'failed',
              ...(success
                ? {}
                : {
                    error: {
                      message: 'Token expired',
                      codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 401 } },
                    },
                  }),
            },
          },
        },
      ])
        child.stdout.write(`${JSON.stringify(data)}\n`)
      child.emit('close', 0)
    }
    now.mockReturnValue(30_000)
    finish(children[0], false)
    await vi.waitFor(() => expect(spawnCli).toHaveBeenCalledTimes(2))
    expect(resolveCredentials).toHaveBeenLastCalledWith('poa_a', undefined, { forceRefresh: true })
    expect(run.mock.calls.map(([options]) => options.timeoutMs)).toEqual([60_000, 31_000])
    const messages: Record<string, unknown>[] = []
    children[1].stdin.on('data', (chunk) => messages.push(JSON.parse(String(chunk))))
    finish(children[1], true)
    await expect(promise).resolves.toMatchObject({
      success: true,
      chatId: encodeCodexOAuthChatId('poa_a', 'thread-a'),
      usage: { inputTokens: 20, outputTokens: 4 },
    })
    expect(messages[2]).toMatchObject({ method: 'thread/resume', params: { threadId: 'thread-a' } })
    expect(JSON.stringify(messages)).not.toContain('Transfer once')
    expect(spawnCli.mock.calls[1][2].env.ACCESS_TOKEN).toBe('renewed-token')
    expect(onLogEntry).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'system', subtype: 'oauth_token_refreshed' }),
    )
  })

  it('does not refresh for unstructured 401-like text or repeatedly refresh rejected tokens', async () => {
    for (const structured of [false, true]) {
      resolveCredentials.mockReset().mockResolvedValue({ accessToken: 'token' })
      spawnCli.mockReset()
      const children: FakeChild[] = []
      spawnCli.mockImplementation(() => {
        const child = new FakeChild()
        children.push(child)
        return child
      })
      const promise = execute(new CodexAgentEngine(config), {
        taskId: `bounded-recovery-${structured}`,
        workDir: '/tmp',
        prompt: 'Do not replay me',
        agentConfig: { authMode: 'oauth', providerOauthAccountId: 'poa_a' },
      })
      const rejection = expect(promise).rejects.toThrow(
        structured ? /unauthorized recovery failed/ : /401/,
      )
      for (let attempt = 0; attempt < (structured ? 2 : 1); attempt++) {
        await vi.waitFor(() => expect(children).toHaveLength(attempt + 1))
        const child = children[attempt]
        child.emit('spawn')
        for (const message of [
          { id: 1, result: {} },
          { id: 2, result: { thread: { id: 'thread-a' } } },
          { id: 3, result: { turn: { id: 'turn-a' } } },
          {
            method: 'turn/completed',
            params: {
              turn: {
                id: 'turn-a',
                status: 'failed',
                error: {
                  message: 'An unrelated 401 appears here',
                  ...(structured ? { codexErrorInfo: 'unauthorized' } : {}),
                },
              },
            },
          },
        ])
          child.stdout.write(`${JSON.stringify(message)}\n`)
        child.emit('close', 0)
      }
      await rejection
      expect(spawnCli).toHaveBeenCalledTimes(structured ? 2 : 1)
      expect(resolveCredentials).toHaveBeenCalledTimes(structured ? 2 : 1)
    }
  })

  it('refuses OAuth without a stored account before spawning a process', async () => {
    await expect(
      execute(new CodexAgentEngine(config), {
        taskId: 'missing',
        workDir: '/tmp',
        prompt: 'hello',
        agentConfig: { authMode: 'oauth' },
      }),
    ).rejects.toThrow(/account/i)
    expect(spawnCli).not.toHaveBeenCalled()
  })

  it('fetches model entitlement from the selected account instead of the bundled CLI catalog', async () => {
    resolveCredentials.mockResolvedValue({ accessToken: 'fresh-account-token' })
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          models: [
            {
              slug: 'account-model',
              display_name: 'Account Model',
              visibility: 'list',
              default_reasoning_level: 'medium',
              supported_reasoning_levels: [
                { effort: 'medium', description: 'Balanced' },
                { effort: 'high', description: 'Thorough' },
              ],
            },
            { slug: 'hidden-model', visibility: 'hide' },
            { slug: 'another-model', visibility: 'list' },
          ],
        }),
      ),
    )
    vi.stubGlobal('fetch', fetch)
    const result = await new CodexAgentEngine(config).listAvailableModels({
      authMode: 'oauth',
      oauthAccountId: 'pacc_a',
    })
    expect(result.models).toEqual(['account-model', 'another-model'])
    expect(result.modelCapabilities?.['account-model']).toMatchObject({
      defaultReasoningEffort: 'medium',
      reasoningEfforts: [
        { value: 'medium', description: 'Balanced' },
        { value: 'high', description: 'Thorough' },
      ],
    })
    expect(fetch).toHaveBeenCalledWith(
      'https://api.openai.com/v1/models',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer fresh-account-token' }),
      }),
    )
    expect(spawnCli).not.toHaveBeenCalled()
  })

  it('reports denied and malformed model responses without returning secret-bearing bodies', async () => {
    resolveCredentials.mockResolvedValue({ accessToken: 'fresh-account-token' })
    const fetch = vi.fn().mockResolvedValue(new Response('secret body', { status: 401 }))
    vi.stubGlobal('fetch', fetch)
    const engine = new CodexAgentEngine(config)
    expect(
      await engine.listAvailableModels({ authMode: 'oauth', oauthAccountId: 'pacc_a' }),
    ).toMatchObject({ models: [], code: 'http_error', details: { status: 401 } })
    fetch.mockResolvedValue(new Response('bad json'))
    expect(
      await engine.listAvailableModels({ authMode: 'oauth', oauthAccountId: 'pacc_a' }),
    ).toMatchObject({ models: [], code: 'parse_failed' })
  })
})
