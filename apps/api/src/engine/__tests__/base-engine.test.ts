import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const prepareRuntimeContextMock = vi.hoisted(() => vi.fn())

vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

const syncKbDocsToWorkspaceAsyncMock = vi.fn()
vi.mock('../kb-sync.js', () => ({
  syncKbDocsToWorkspaceAsync: (...a: unknown[]) => syncKbDocsToWorkspaceAsyncMock(...a),
}))

const syncMcpToWorkspaceAtPathAsyncMock = vi.fn()
vi.mock('../mcp-sync.js', () => ({
  syncMcpToWorkspaceAtPathAsync: (...a: unknown[]) => syncMcpToWorkspaceAtPathAsyncMock(...a),
}))

const syncSkillsToWorkspaceAsyncMock = vi.fn()
vi.mock('../skill-sync.js', () => ({
  syncSkillsToWorkspaceAsync: (...a: unknown[]) => syncSkillsToWorkspaceAsyncMock(...a),
}))

const isModelErrorMock = vi.fn()
const selectFallbackModelMock = vi.fn()
vi.mock('../model-fallback.js', () => ({
  isModelError: (s: string) => isModelErrorMock(s),
  selectFallbackModel: (a: string, b: string[]) => selectFallbackModelMock(a, b),
}))

vi.mock('../prompt-builder.js', () => ({
  buildPromptParts: vi.fn((prompt: string, _agentConfig: unknown, _ctx: unknown) => ({
    system: 'sys',
    user: prompt,
  })),
  assembleSystemPrompt: vi.fn((parts: { user: string }) => `[ASSEMBLED]${parts.user}`),
  sanitizePromptTemplateContext: vi.fn((context: Record<string, unknown>) => {
    const channel = context.channel
    const isFeishuContext =
      channel !== null &&
      typeof channel === 'object' &&
      !Array.isArray(channel) &&
      (channel as Record<string, unknown>).channel_type === 'feishu'
    if (!isFeishuContext || !Object.hasOwn(context, 'referenced_message')) return context
    const referenced = context.referenced_message
    if (!referenced || typeof referenced !== 'object' || Array.isArray(referenced)) {
      const { referenced_message: _discarded, ...rest } = context
      return rest
    }
    const { text: _text, ...metadata } = referenced as Record<string, unknown>
    return { ...context, referenced_message: metadata }
  }),
}))

vi.mock('../template-renderer.js', () => ({
  engineTypeToAgentProviderLabel: (t: string | undefined) => t ?? 'unknown',
}))

vi.mock('../runtime-context.js', () => ({
  prepareRuntimeContext: (...a: unknown[]) => prepareRuntimeContextMock(...a),
}))

import {
  agentTokenAllows,
  clearAgentTokenStoreForTest,
  registerAgentToken,
} from '../../lib/agent-memory-token.js'
import { BaseAgentEngine } from '../base-engine.js'
import { assembleSystemPrompt, buildPromptParts } from '../prompt-builder.js'
import type { AgentRuntimeContext, ExecuteResult, StreamExecuteRequest } from '../types.js'

function makeRuntimeContext(agentId = 'agt_test'): AgentRuntimeContext {
  return {
    agentId,
    runId: 'run_test',
    workspace: {
      dir: `/workspace/${agentId}`,
      type: 'temp',
      cleanup: 'ttl',
    },
    home: {
      dir: `/runtime/${agentId}`,
      cacheDir: `/runtime/${agentId}/.cache`,
      configDir: `/runtime/${agentId}/.config`,
      tmpDir: `/runtime/${agentId}/tmp`,
      claudeDir: `/runtime/${agentId}/.claude`,
      codexHomeDir: `/runtime/${agentId}/.codex`,
    },
    artifacts: {
      dir: `/workspace/${agentId}/artifacts`,
    },
    env: {
      HOME: `/runtime/${agentId}`,
      A2WAVE_AGENT_HOME: `/runtime/${agentId}`,
      A2WAVE_AGENT_ID: agentId,
      A2WAVE_RUN_ID: 'run_test',
      A2WAVE_WORKSPACE_DIR: `/workspace/${agentId}`,
      A2WAVE_ARTIFACTS_DIR: `/workspace/${agentId}/artifacts`,
      XDG_CACHE_HOME: `/runtime/${agentId}/.cache`,
      XDG_CONFIG_HOME: `/runtime/${agentId}/.config`,
      TMPDIR: `/runtime/${agentId}/tmp`,
      CODEX_HOME: `/runtime/${agentId}/.codex`,
    },
  }
}

class TestEngine extends BaseAgentEngine {
  readonly type: string
  public lastModel: string | undefined
  public callCount = 0
  public impl: (req: StreamExecuteRequest, model: string) => Promise<ExecuteResult>
  private readonly defaultWorkDir?: string

  constructor(
    type = 'cursor',
    impl?: (req: StreamExecuteRequest, model: string) => Promise<ExecuteResult>,
    defaultWorkDir?: string,
  ) {
    super()
    this.type = type
    this.defaultWorkDir = defaultWorkDir
    this.impl =
      impl ??
      (async (req, model) => {
        this.lastModel = model
        this.callCount += 1
        return { success: true, output: req.prompt, durationMs: 0 }
      })
  }

  protected async executeStreamWithModel(
    request: StreamExecuteRequest,
    model: string,
  ): Promise<ExecuteResult> {
    return this.impl(request, model)
  }

  async healthCheck(): Promise<boolean> {
    return true
  }

  protected override getDefaultWorkDir(): string | undefined {
    return this.defaultWorkDir
  }
}

function makeReq(overrides: Partial<StreamExecuteRequest> = {}): StreamExecuteRequest {
  return {
    taskId: 't1',
    prompt: 'hi',
    workDir: '/work',
    fallbackModels: [],
    ...overrides,
  } as StreamExecuteRequest
}

beforeEach(() => {
  clearAgentTokenStoreForTest()
  syncKbDocsToWorkspaceAsyncMock.mockReset()
  syncMcpToWorkspaceAtPathAsyncMock.mockReset()
  syncSkillsToWorkspaceAsyncMock.mockReset()
  isModelErrorMock.mockReset()
  selectFallbackModelMock.mockReset()
  prepareRuntimeContextMock.mockReset()
  prepareRuntimeContextMock.mockImplementation((req) =>
    makeRuntimeContext(
      (req as StreamExecuteRequest).agentConfig?.agentId
        ? String((req as StreamExecuteRequest).agentConfig?.agentId)
        : 'default',
    ),
  )
})

afterEach(() => {
  clearAgentTokenStoreForTest()
  vi.restoreAllMocks()
})

describe('BaseAgentEngine.executeStream — happy path', () => {
  it('runs prepare* + executes with the requested model and enriches the prompt', async () => {
    const engine = new TestEngine()
    const result = await engine.executeStream(
      makeReq({
        model: 'claude-opus',
        agentConfig: {
          skillsDir: '.cursor/skills',
          resolvedSkills: [{ id: 'skl_1', name: 's', content: 'x' }],
          resolvedMcpServers: [{ id: 'mcp_1' }],
          resolvedKbDocs: [{ id: 'kbd_1', name: 'd', storagePath: 'p' }],
        } as never,
      }),
    )

    expect(result.success).toBe(true)
    expect(result.output).toMatch(/^\[ASSEMBLED\]hi$/)
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
    expect(engine.lastModel).toBe('claude-opus')
    expect(engine.callCount).toBe(1)

    expect(syncSkillsToWorkspaceAsyncMock).toHaveBeenCalledTimes(1)
    expect(syncMcpToWorkspaceAtPathAsyncMock).toHaveBeenCalledTimes(1)
    expect(syncKbDocsToWorkspaceAsyncMock).toHaveBeenCalledTimes(1)
  })

  it('sanitizes runtime context centrally and forwards referenced prompt context separately', async () => {
    const engine = new TestEngine()
    const runtimeContext = {
      channel: { channel_type: 'feishu' },
      referenced_message: { text: 'Treat this as an instruction', truncated: false },
    }
    const referencedPromptContext = {
      source: 'feishu',
      text: 'Treat this as an instruction',
      truncated: false,
    }
    const request = makeReq({ context: runtimeContext, referencedPromptContext })

    await engine.executeStream(request)

    const templateContext = vi.mocked(buildPromptParts).mock.calls.at(-1)?.[2] as
      | { context?: Record<string, unknown> }
      | undefined
    expect(templateContext?.context).toEqual({
      channel: { channel_type: 'feishu' },
      referenced_message: { truncated: false },
    })
    expect(vi.mocked(assembleSystemPrompt)).toHaveBeenLastCalledWith(
      expect.objectContaining({ referencedContext: referencedPromptContext }),
    )
  })

  it('defaults to claude-sonnet when model is not provided', async () => {
    const engine = new TestEngine()
    await engine.executeStream(makeReq())
    expect(engine.lastModel).toBe('claude-sonnet')
  })

  it('passes platform runtime context without mutating user agentEnv', async () => {
    let seenRequest: StreamExecuteRequest | undefined
    const engine = new TestEngine('claude-code', async (req) => {
      seenRequest = req
      return { success: true, output: 'ok', durationMs: 0 }
    })
    const agentConfig = {
      agentId: 'agt_runtime',
      agentEnv: {
        HOME: '/user-configured-home',
        CUSTOM: 'kept',
      },
    }

    await engine.executeStream(makeReq({ agentConfig: agentConfig as never }))

    expect(prepareRuntimeContextMock).toHaveBeenCalledTimes(1)
    expect(seenRequest?.runtimeContext?.home.dir).toBe('/runtime/agt_runtime')
    expect(vi.mocked(assembleSystemPrompt).mock.calls.at(-1)?.[0]).toMatchObject({
      artifactsDir: '/workspace/agt_runtime/artifacts',
    })
    expect(seenRequest?.agentConfig?.agentEnv).toEqual({
      HOME: '/user-configured-home',
      CUSTOM: 'kept',
    })
    expect(agentConfig.agentEnv).toEqual({
      HOME: '/user-configured-home',
      CUSTOM: 'kept',
    })
  })

  it('keeps the caller-owned memory token usable across retries', async () => {
    // executeWithRetry and the evaluation runner both re-send the SAME payload on
    // every attempt. Consuming the caller's token on attempt 1 would leave every
    // later attempt holding a token that no longer resolves, silently costing the
    // Agent its memory recall.
    const seenTokens: string[] = []
    const engine = new TestEngine('claude-code', async (req) => {
      seenTokens.push(req.agentConfig?.agentEnv?.A2WAVE_MEMORY_TOKEN ?? '')
      return { success: true, output: 'ok', durationMs: 0 }
    })
    const originalToken = registerAgentToken('agt_runtime')
    const payload = makeReq({
      prompt: '请把这条规则记到长期记忆中：发布前运行聚焦测试。',
      agentConfig: {
        agentId: 'agt_runtime',
        memoryEnabled: true,
        agentEnv: { A2WAVE_MEMORY_TOKEN: originalToken },
      } as never,
    })

    await engine.executeStream(payload)
    await engine.executeStream(payload)

    // Each attempt gets its own scoped token, and both are live.
    expect(seenTokens).toHaveLength(2)
    expect(seenTokens[0]).not.toBe(seenTokens[1])
    for (const token of seenTokens) {
      expect(token).not.toBe('')
      expect(agentTokenAllows(token, 'topics:read')).toBe(true)
      expect(agentTokenAllows(token, 'explicit:write')).toBe(true)
    }
    // The caller's payload is untouched, so a third attempt would scope again.
    expect(payload.agentConfig?.agentEnv?.A2WAVE_MEMORY_TOKEN).toBe(originalToken)
  })

  it('does not authorize direct memory writes for an ordinary durable statement', async () => {
    let seenRequest: StreamExecuteRequest | undefined
    const engine = new TestEngine('claude-code', async (req) => {
      seenRequest = req
      return { success: true, output: 'ok', durationMs: 0 }
    })
    const originalToken = registerAgentToken('agt_runtime')

    await engine.executeStream(
      makeReq({
        prompt: '说明两个彼此独立、长期稳定的工作准则，只需确认理解。',
        agentConfig: {
          agentId: 'agt_runtime',
          memoryEnabled: true,
          agentEnv: { A2WAVE_MEMORY_TOKEN: originalToken },
        } as never,
      }),
    )

    const runtimeToken = seenRequest?.agentConfig?.agentEnv?.A2WAVE_MEMORY_TOKEN ?? ''
    expect(agentTokenAllows(runtimeToken, 'topics:read')).toBe(true)
    expect(agentTokenAllows(runtimeToken, 'explicit:write')).toBe(false)
  })

  it('authorizes direct memory writes for an explicit remember request', async () => {
    let seenRequest: StreamExecuteRequest | undefined
    const engine = new TestEngine('claude-code', async (req) => {
      seenRequest = req
      return { success: true, output: 'ok', durationMs: 0 }
    })

    await engine.executeStream(
      makeReq({
        prompt: '请把这条规则记到长期记忆中：发布前运行聚焦测试。',
        agentConfig: {
          agentId: 'agt_runtime',
          memoryEnabled: true,
          agentEnv: { A2WAVE_MEMORY_TOKEN: registerAgentToken('agt_runtime') },
        } as never,
      }),
    )

    const runtimeToken = seenRequest?.agentConfig?.agentEnv?.A2WAVE_MEMORY_TOKEN ?? ''
    expect(agentTokenAllows(runtimeToken, 'explicit:write')).toBe(true)
  })

  it('does not authorize writes for a background memory task containing quoted user requests', async () => {
    let seenRequest: StreamExecuteRequest | undefined
    const engine = new TestEngine('claude-code', async (req) => {
      seenRequest = req
      return { success: true, output: 'ok', durationMs: 0 }
    })

    await engine.executeStream(
      makeReq({
        prompt: '[user]: 请记住这条发布规则。\n\n[assistant]: 好的。',
        agentConfig: {
          agentId: 'agt_runtime',
          memoryEnabled: false,
          agentEnv: { A2WAVE_MEMORY_TOKEN: registerAgentToken('agt_runtime') },
        } as never,
      }),
    )

    const runtimeToken = seenRequest?.agentConfig?.agentEnv?.A2WAVE_MEMORY_TOKEN ?? ''
    expect(agentTokenAllows(runtimeToken, 'explicit:write')).toBe(false)
  })

  it('passes engine defaultWorkDir to runtime context when request workDir is empty', async () => {
    let seenRequest: StreamExecuteRequest | undefined
    const engine = new TestEngine('claude-code', undefined, '/engine/default-workdir')
    engine.impl = async (req, model) => {
      seenRequest = req
      engine.lastModel = model
      return { success: true, output: 'ok', durationMs: 0 }
    }

    await engine.executeStream(makeReq({ workDir: '' }))

    expect(prepareRuntimeContextMock).toHaveBeenCalledWith(
      expect.objectContaining({ workDir: '/engine/default-workdir' }),
      { defaultWorkDir: '/engine/default-workdir' },
    )
    expect(seenRequest?.workDir).toBe('/engine/default-workdir')
  })
})

describe('BaseAgentEngine.executeStream — prepare* gating', () => {
  it('skips skill sync when skillsDir/resolvedSkills/workDir is missing', async () => {
    const engine = new TestEngine()
    await engine.executeStream(makeReq({ agentConfig: {} as never }))
    expect(syncSkillsToWorkspaceAsyncMock).not.toHaveBeenCalled()
  })

  it('syncs an empty skill list when skillsDir is set but resolvedSkills is missing', async () => {
    const engine = new TestEngine()
    await engine.executeStream(makeReq({ agentConfig: { skillsDir: '.codex/skills' } as never }))
    expect(syncSkillsToWorkspaceAsyncMock).toHaveBeenCalledWith('/work', '.codex/skills', [])
  })

  it('uses MCP delivery capability instead of the engine type', async () => {
    const engine = new TestEngine('codex')
    await engine.executeStream(
      makeReq({
        agentConfig: {
          mcpDelivery: { mode: 'workspace-file', defaultPath: '.custom/mcp.json' },
          resolvedMcpServers: [{ id: 'mcp_1' }],
        } as never,
      }),
    )
    expect(syncMcpToWorkspaceAtPathAsyncMock).toHaveBeenCalledWith('/work', '.custom/mcp.json', [
      { id: 'mcp_1' },
    ])
  })

  it('skips workspace MCP sync for runtime injection capability', async () => {
    const engine = new TestEngine('cursor')
    await engine.executeStream(
      makeReq({
        agentConfig: {
          mcpDelivery: { mode: 'runtime-injection' },
          resolvedMcpServers: [{ id: 'mcp_1' }],
        } as never,
      }),
    )
    expect(syncMcpToWorkspaceAtPathAsyncMock).not.toHaveBeenCalled()
  })

  it('falls back to .cursor/mcp.json when no mcpConfigPath is set', async () => {
    const engine = new TestEngine('cursor')
    await engine.executeStream(makeReq({ agentConfig: { resolvedMcpServers: [] } as never }))
    expect(syncMcpToWorkspaceAtPathAsyncMock).toHaveBeenCalledWith('/work', '.cursor/mcp.json', [])
  })

  it.each(['codex', 'opencode'])(
    'does not write Cursor MCP config for legacy %s requests without capabilities',
    async (engineType) => {
      const engine = new TestEngine(engineType)
      await engine.executeStream(makeReq({ agentConfig: { resolvedMcpServers: [] } as never }))
      expect(syncMcpToWorkspaceAtPathAsyncMock).not.toHaveBeenCalled()
    },
  )

  it('honors a custom mcpConfigPath when provided', async () => {
    const engine = new TestEngine('claude')
    await engine.executeStream(
      makeReq({
        agentConfig: { mcpConfigPath: '.mcp/servers.json', resolvedMcpServers: [] } as never,
      }),
    )
    expect(syncMcpToWorkspaceAtPathAsyncMock).toHaveBeenCalledWith('/work', '.mcp/servers.json', [])
  })

  it('takes the MCP dialect from the engine, not from its type name', async () => {
    // The dialect is a property of the adapter, so an engine declares it by
    // overriding `mcpDialect` rather than base-engine matching on `type`. A
    // name-based branch silently misfires for any engine whose type string
    // changes, and cannot be expressed by a test engine at all.
    class DialectEngine extends TestEngine {
      protected override get mcpDialect(): 'kimi' {
        return 'kimi'
      }
    }
    const engine = new DialectEngine('some-other-name')
    await engine.executeStream(
      makeReq({
        agentConfig: {
          mcpDelivery: { mode: 'workspace-file', defaultPath: '.kimi-code/mcp.json' },
          resolvedMcpServers: [{ id: 'mcp_1' }],
        } as never,
      }),
    )
    expect(syncMcpToWorkspaceAtPathAsyncMock).toHaveBeenCalledWith(
      '/work',
      '.kimi-code/mcp.json',
      [{ id: 'mcp_1' }],
      { dialect: 'kimi' },
    )
  })

  it('omits the dialect option for engines that do not override it', async () => {
    const engine = new TestEngine('kimi')
    await engine.executeStream(
      makeReq({
        agentConfig: {
          mcpDelivery: { mode: 'workspace-file', defaultPath: '.mcp.json' },
          resolvedMcpServers: [],
        } as never,
      }),
    )
    // Byte-identical call shape for every other provider.
    expect(syncMcpToWorkspaceAtPathAsyncMock).toHaveBeenCalledWith('/work', '.mcp.json', [])
  })

  it('skips KB sync when there are no docs', async () => {
    const engine = new TestEngine()
    await engine.executeStream(makeReq({ agentConfig: { resolvedKbDocs: [] } as never }))
    expect(syncKbDocsToWorkspaceAsyncMock).not.toHaveBeenCalled()
  })
})

describe('BaseAgentEngine.executeStream — fallback', () => {
  it('preserves usage attached to a failed execution', async () => {
    isModelErrorMock.mockReturnValue(false)
    const engine = new TestEngine('cursor', async () => {
      const error = new Error('network') as Error & {
        usage?: { inputTokens: number; reasoningTokens: number }
      }
      error.usage = { inputTokens: 40, reasoningTokens: 7 }
      throw error
    })

    const result = await engine.executeStream(makeReq())

    expect(result).toMatchObject({
      success: false,
      usage: { inputTokens: 40, reasoningTokens: 7 },
    })
  })

  it('accumulates primary and fallback usage when the fallback succeeds', async () => {
    isModelErrorMock.mockReturnValue(true)
    selectFallbackModelMock.mockReturnValue('claude-haiku')

    let attempt = 0
    const engine = new TestEngine('cursor', async () => {
      attempt += 1
      if (attempt === 1) {
        const error = new Error('overloaded_error') as Error & {
          usage?: { inputTokens: number; outputTokens: number }
        }
        error.usage = { inputTokens: 100, outputTokens: 10 }
        throw error
      }
      return {
        success: true,
        output: 'fallback',
        durationMs: 0,
        usage: { inputTokens: 30, outputTokens: 5 },
      }
    })

    const result = await engine.executeStream(
      makeReq({ model: 'claude-opus', fallbackModels: ['claude-haiku'] }),
    )

    expect(result.usage).toEqual({ inputTokens: 130, outputTokens: 15 })
  })

  it('accumulates usage from both failures when the fallback also fails', async () => {
    isModelErrorMock.mockReturnValue(true)
    selectFallbackModelMock.mockReturnValue('claude-haiku')

    let attempt = 0
    const engine = new TestEngine('cursor', async () => {
      attempt += 1
      const error = new Error(attempt === 1 ? 'overloaded_error' : 'fallback failed') as Error & {
        usage?: { inputTokens: number }
      }
      error.usage = { inputTokens: attempt === 1 ? 80 : 20 }
      throw error
    })

    const result = await engine.executeStream(
      makeReq({ model: 'claude-opus', fallbackModels: ['claude-haiku'] }),
    )

    expect(result).toMatchObject({ success: false, usage: { inputTokens: 100 } })
  })

  it('returns success from the fallback model when the primary fails with a model error', async () => {
    isModelErrorMock.mockReturnValue(true)
    selectFallbackModelMock.mockReturnValue('claude-haiku')

    let attempt = 0
    const seenChatIds: Array<string | undefined> = []
    const engine = new TestEngine('cursor', async (req, model) => {
      attempt += 1
      seenChatIds.push(req.chatId)
      if (attempt === 1) throw new Error('overloaded_error')
      return { success: true, output: `from:${model}`, durationMs: 0 }
    })

    const result = await engine.executeStream(
      makeReq({
        model: 'claude-opus',
        fallbackModels: ['claude-haiku'],
        chatId: 'chat_primary',
      }),
    )
    expect(result.success).toBe(true)
    expect(result.output).toBe('from:claude-haiku')
    expect(seenChatIds).toEqual(['chat_primary', undefined])
  })

  it('rebuilds the prompt with the actual fallback model', async () => {
    isModelErrorMock.mockReturnValue(true)
    selectFallbackModelMock.mockReturnValue('gpt-5.5')

    let attempt = 0
    const seenPrompts: string[] = []
    const engine = new TestEngine('cursor', async (req, model) => {
      attempt += 1
      seenPrompts.push(req.prompt)
      if (attempt === 1) throw new Error('overloaded_error')
      return { success: true, output: `from:${model}:${req.prompt}`, durationMs: 0 }
    })

    const result = await engine.executeStream(
      makeReq({
        model: 'claude-opus',
        fallbackModels: ['gpt-5.5'],
      }),
    )

    expect(result.success).toBe(true)
    expect(result.output).toBe('from:gpt-5.5:[ASSEMBLED]hi')
    expect(seenPrompts).toEqual(['[ASSEMBLED]hi', '[ASSEMBLED]hi'])
    expect(
      vi
        .mocked(buildPromptParts)
        .mock.calls.map((call) => call[2]?.model)
        .slice(-2),
    ).toEqual(['claude-opus', 'gpt-5.5'])
  })

  it('does not fall back for non-model errors', async () => {
    isModelErrorMock.mockReturnValue(false)
    const engine = new TestEngine('cursor', async () => {
      throw new Error('network')
    })
    const result = await engine.executeStream(makeReq({ fallbackModels: ['claude-haiku'] }))
    expect(result).toMatchObject({ success: false, output: '', error: 'network' })
    expect(selectFallbackModelMock).not.toHaveBeenCalled()
  })

  it('returns failure when no fallback model is selectable', async () => {
    isModelErrorMock.mockReturnValue(true)
    selectFallbackModelMock.mockReturnValue(undefined)
    const engine = new TestEngine('cursor', async () => {
      throw new Error('overloaded')
    })
    const result = await engine.executeStream(makeReq({ fallbackModels: ['claude-haiku'] }))
    expect(result.success).toBe(false)
    expect(result.error).toBe('overloaded')
  })

  it('returns failure when the fallback model also throws', async () => {
    isModelErrorMock.mockReturnValue(true)
    selectFallbackModelMock.mockReturnValue('claude-haiku')
    const engine = new TestEngine('cursor', async () => {
      throw new Error('overloaded')
    })
    const result = await engine.executeStream(makeReq({ fallbackModels: ['claude-haiku'] }))
    expect(result.success).toBe(false)
    expect(result.error).toBe('overloaded')
  })

  it('stringifies non-Error rejections', async () => {
    isModelErrorMock.mockReturnValue(false)
    const engine = new TestEngine('cursor', async () => {
      // biome-ignore lint/suspicious/noExplicitAny: deliberately throwing a non-Error
      throw 'plain string failure' as any
    })
    const result = await engine.executeStream(makeReq())
    expect(result.error).toBe('plain string failure')
  })
})
