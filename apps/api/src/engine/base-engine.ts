/**
 * BaseAgentEngine — 所有引擎的抽象基类
 *
 * 封装了所有引擎共享的逻辑：
 * 1. Prompt 组装与安全包装（enrichPrompt）
 * 2. 模型 fallback 循环
 * 3. 执行计时与日志
 *
 * 子类只需实现：
 * - executeWithModel: 用指定模型执行单次请求
 * - executeStreamWithModel: 用指定模型执行单次流式请求
 * - healthCheck: 引擎可用性检查
 */

import { join } from 'node:path'
import type { ProviderMcpDelivery } from '@a2wave/shared'
import {
  getRuntimeMemoryTokenClaims,
  registerAgentToken,
  runtimeMemoryActionsForPrompt,
} from '../lib/agent-memory-token.js'
import { logger } from '../lib/logger.js'
import { buildMemoryContext, buildRecallInstruction } from '../lib/memory-context.js'
import { removeMemoryOverride } from '../lib/memory-storage.js'
import { type KbDocFile, syncKbDocsToWorkspaceAsync } from './kb-sync.js'
import {
  cleanupManagedMcpConfigAsync,
  type McpConfigDialect,
  type ResolvedMcpServer,
  syncMcpToWorkspaceAtPathAsync,
} from './mcp-sync.js'
import { isModelError, selectFallbackModel } from './model-fallback.js'
import { assembleSystemPrompt, buildPromptParts } from './prompt-builder.js'
import { artifactsDirForTask, prepareRuntimeContext } from './runtime-context.js'
import { type SkillFile, syncSkillsToWorkspaceAsync } from './skill-sync.js'
import { engineTypeToAgentProviderLabel, type TemplateContext } from './template-renderer.js'
import type { AgentEngine, ExecuteRequest, ExecuteResult, StreamExecuteRequest } from './types.js'
import { accumulateUsage, extractUsageFromError } from './usage.js'

export abstract class BaseAgentEngine implements AgentEngine {
  abstract readonly type: string

  /** 子类实现：用指定模型执行单次请求（spawn + stream-json） */
  protected abstract executeStreamWithModel(
    request: StreamExecuteRequest,
    model: string,
  ): Promise<ExecuteResult>

  /** 子类实现：检查引擎是否可用 */
  abstract healthCheck(): Promise<boolean>

  /**
   * The mcp.json dialect this engine's CLI reads, or undefined for the
   * Claude-Code-family default.
   *
   * Owned by the adapter, not derived from `this.type`: a name-based branch here
   * silently misfires if an engine's type string ever changes, and it puts
   * knowledge of one CLI's file format in the shared base. Kept off the
   * `mcpDelivery` capability in @a2wave/shared on purpose — that is a
   * cross-app contract, and the spelling of a config key is an execution
   * detail no route or UI consumes.
   */
  protected get mcpDialect(): McpConfigDialect | undefined {
    return undefined
  }

  /** 子类可提供引擎默认工作目录，用于 workDir 为空时保持 runtime 与实际 cwd 一致。 */
  protected getDefaultWorkDir(): string | undefined {
    return undefined
  }

  // ----------------------------------------------------------
  // Public: 执行（含 fallback 循环）
  // ----------------------------------------------------------

  async executeStream(request: StreamExecuteRequest): Promise<ExecuteResult> {
    const start = Date.now()
    const { model = 'claude-sonnet', fallbackModels = [] } = request
    const defaultWorkDir = this.getDefaultWorkDir()
    const preparedRequest = this.withScopedMemoryToken(
      this.withDefaultWorkDir(request, defaultWorkDir),
    )
    // The prepare phase is INSIDE the try because `prepareMcpServers` writes
    // live credentials in plaintext into a workspace that outlives the run
    // (per-Agent worktrees are persistent). A sibling prepare step rejecting
    // after that write — or `prepareRuntimeContext` / `enrichPrompt` throwing —
    // would otherwise leave the secrets and the in-process refcount behind.
    // Fallback attempts all reuse the same file, hence the single outer finally.
    try {
      const memoryContextPromise = this.fetchMemoryContext(preparedRequest)
      let runtimeRequest: StreamExecuteRequest | undefined
      let memoryContext: string | null = null
      let modelCallStarted = false
      try {
        await Promise.all([
          this.prepareSkills(preparedRequest),
          this.prepareMcpServers(preparedRequest),
          this.prepareKbDocs(preparedRequest),
          memoryContextPromise,
        ])
        this.prepareMemoryOverride(preparedRequest)
        const runtimeContext = prepareRuntimeContext(preparedRequest, {
          defaultWorkDir,
        })
        runtimeRequest = { ...preparedRequest, runtimeContext }
        memoryContext = await memoryContextPromise
        const enriched = this.enrichPrompt(
          runtimeRequest,
          model,
          memoryContext,
        ) as StreamExecuteRequest
        modelCallStarted = true
        const result = await this.executeStreamWithModel(enriched, model)
        return { ...result, durationMs: Date.now() - start }
      } catch (err) {
        // Only a failure of the model call itself is a fallback candidate. A
        // prepare failure means no attempt was ever made, so retrying another
        // model would repeat the same broken preparation.
        if (!modelCallStarted || !runtimeRequest) throw err
        return this.handleFallback(runtimeRequest, model, fallbackModels, err, start, memoryContext)
      }
    } finally {
      await this.cleanupMcpServers(preparedRequest)
    }
  }

  private withDefaultWorkDir<T extends StreamExecuteRequest>(
    request: T,
    defaultWorkDir?: string,
  ): T {
    if ((request.workDir ?? '').trim() || !defaultWorkDir?.trim()) return request
    return { ...request, workDir: defaultWorkDir } as T
  }

  private withScopedMemoryToken<T extends StreamExecuteRequest>(request: T): T {
    const agentId = request.agentConfig?.agentId
    const agentEnv = request.agentConfig?.agentEnv
    const currentToken = agentEnv?.A2WAVE_MEMORY_TOKEN
    if (!agentId || !currentToken) return request

    const claims = getRuntimeMemoryTokenClaims(currentToken)
    if (!claims || claims.agentId !== agentId) return request

    const scopedToken = registerAgentToken(agentId, {
      runStepId: request.taskId,
      bundleVersion: claims.bundleVersion,
      allowedActions:
        request.agentConfig?.memoryEnabled === false
          ? runtimeMemoryActionsForPrompt('')
          : runtimeMemoryActionsForPrompt(request.prompt),
      maxTopicReads: claims.maxTopicReads,
      maxTopicTokens: claims.maxTopicTokens,
    })

    // The parent token is deliberately left live. It belongs to the caller, and
    // both executeWithRetry and the evaluation runner re-send the SAME payload on
    // every attempt — revoking it here would leave attempt 2 onward carrying a
    // token that no longer resolves, silently costing the Agent its memory recall
    // with no error surfaced. It expires on its own TTL and is revoked wholesale
    // when the Agent is deleted.
    return {
      ...request,
      agentConfig: {
        ...request.agentConfig,
        agentEnv: { ...agentEnv, A2WAVE_MEMORY_TOKEN: scopedToken },
      },
    }
  }

  // ----------------------------------------------------------
  // Private: Skill 文件同步（Provider 驱动）
  // ----------------------------------------------------------

  /**
   * 若 Provider 声明了 skillsDir，将 skills 同步为文件。
   * 完整 Skill 内容仍由执行引擎从文件发现；非 Claude 模型仅在 prompt 中注入轻量索引。
   */
  protected async prepareSkills(request: ExecuteRequest): Promise<void> {
    const { workDir, agentConfig } = request
    const skillsDir = agentConfig?.skillsDir as string | undefined
    const resolvedSkills = agentConfig?.resolvedSkills as SkillFile[] | undefined

    if (skillsDir && workDir) {
      await syncSkillsToWorkspaceAsync(workDir, skillsDir, resolvedSkills ?? [])
      logger.debug(
        { taskId: request.taskId, workDir, skillsDir, count: resolvedSkills?.length ?? 0 },
        'Synced skills to workspace',
      )
    }
  }

  // ----------------------------------------------------------
  // Private: MCP configuration synchronization
  // ----------------------------------------------------------

  /**
   * Writes resolvedMcpServers into the workspace according to Provider capabilities.
   * Legacy configurations without capabilities fall back to Cursor's default path so existing
   * Agents keep their behavior. Only a2wave-managed entries are synchronized and merged safely
   * with existing user configuration.
   */
  protected async prepareMcpServers(request: ExecuteRequest): Promise<void> {
    const target = this.resolveMcpWorkspaceTarget(request)
    if (!target) return
    this.syncedMcpRequests.delete(request)
    const { workDir, mcpConfigPath, servers } = target
    // An engine declares its own mcp.json dialect (see `mcpDialect`); engines
    // that don't override it keep the original 3-arg call unchanged.
    const dialect = this.mcpDialect
    await (dialect
      ? syncMcpToWorkspaceAtPathAsync(workDir, mcpConfigPath, servers, { dialect })
      : syncMcpToWorkspaceAtPathAsync(workDir, mcpConfigPath, servers))
    // Only a *completed* sync took a reference; see `cleanupMcpServers`.
    this.syncedMcpRequests.add(request)
    logger.debug(
      { taskId: request.taskId, count: servers.length, mcpConfigPath },
      'Synced MCP servers to workspace',
    )
  }

  /**
   * Remove the workspace MCP config this run's sync wrote.
   *
   * Resolved through the same target function as the write, so a config can
   * never be written to one path and looked for at another. Engines whose MCP
   * delivery is not a workspace file wrote nothing and clean up nothing.
   */
  protected async cleanupMcpServers(request: ExecuteRequest): Promise<void> {
    // A run whose own sync never completed holds no reference. Releasing one
    // anyway would decrement a *concurrent* same-worktree run's refcount to
    // zero and delete the config out from under it, so this path is a no-op.
    if (!this.syncedMcpRequests.has(request)) return
    this.syncedMcpRequests.delete(request)
    const target = this.resolveMcpWorkspaceTarget(request)
    if (!target) return
    await cleanupManagedMcpConfigAsync(target.workDir, target.mcpConfigPath)
  }

  /**
   * Requests whose workspace MCP sync completed, and therefore hold exactly one
   * reference to the managed config file that run-end cleanup must release.
   * Weak so a request object that never reaches cleanup cannot leak.
   */
  private readonly syncedMcpRequests = new WeakSet<ExecuteRequest>()

  /** The workspace MCP config file this request writes, or null if it writes none. */
  private resolveMcpWorkspaceTarget(
    request: ExecuteRequest,
  ): { workDir: string; mcpConfigPath: string; servers: ResolvedMcpServer[] } | null {
    const { workDir, agentConfig } = request
    const servers = agentConfig?.resolvedMcpServers as ResolvedMcpServer[] | undefined
    if (!workDir || servers === undefined) return null
    const delivery = agentConfig?.mcpDelivery as ProviderMcpDelivery | undefined
    if (delivery && delivery.mode !== 'workspace-file') return null
    // Before Provider capabilities were persisted into runtime config, Codex and OpenCode
    // received MCP servers through runtime arguments. Preserve that legacy behavior instead
    // of writing an unrelated Cursor config file into their workspace.
    if (!delivery && (this.type === 'codex' || this.type === 'opencode')) return null
    const mcpConfigPath =
      (agentConfig?.mcpConfigPath as string | undefined) ||
      (delivery?.mode === 'workspace-file' ? delivery.defaultPath : '.cursor/mcp.json')
    return { workDir, mcpConfigPath, servers }
  }

  // ----------------------------------------------------------
  // Private: KB 文档同步
  // ----------------------------------------------------------

  protected async prepareKbDocs(request: ExecuteRequest): Promise<void> {
    const { workDir, agentConfig } = request
    const resolvedKbDocs = agentConfig?.resolvedKbDocs as KbDocFile[] | undefined
    if (resolvedKbDocs?.length && workDir) {
      await syncKbDocsToWorkspaceAsync(workDir, resolvedKbDocs)
      logger.debug(
        { taskId: request.taskId, count: resolvedKbDocs.length },
        'Synced KB docs to workspace',
      )
    }
  }

  // ----------------------------------------------------------
  // Private: Prompt 组装 + 安全包装
  // ----------------------------------------------------------

  /**
   * 将 agent 上下文注入 prompt 并应用安全包装。
   * 返回新的 request 副本，prompt 已替换为最终版本。
   */
  private enrichPrompt<T extends ExecuteRequest>(
    request: T,
    model: string,
    memoryContext?: string | null,
  ): T {
    const { prompt, agentConfig, taskId } = request

    const templateContext: TemplateContext = {
      message: prompt,
      context: request.context ?? {},
      env: agentConfig?.agentEnv as Record<string, string> | undefined,
      model,
      agent_provider: engineTypeToAgentProviderLabel(agentConfig?.engineType),
    }

    const parts = buildPromptParts(prompt, agentConfig, templateContext)
    if (request.runtimeContext?.artifacts.dir) {
      parts.artifactsDir = request.runtimeContext.artifacts.dir
    } else if (request.workDir) {
      parts.artifactsDir = artifactsDirForTask(request.workDir, taskId)
    }
    const cfg = (agentConfig ?? {}) as Record<string, unknown>
    if (cfg.memoryEnabled && (cfg.memoryContextMode as string) !== 'off') {
      parts.recallInstruction = buildRecallInstruction(cfg)
    }
    if (memoryContext) {
      parts.memoryContext = memoryContext
    }
    const finalPrompt = assembleSystemPrompt(parts)

    logger.info({ taskId, promptLength: finalPrompt.length }, 'Final prompt assembled')
    logger.debug({ taskId }, `Final prompt for agent:\n${finalPrompt}`)

    return { ...request, model, prompt: finalPrompt }
  }

  // ----------------------------------------------------------
  // Private: Memory 上下文获取
  // ----------------------------------------------------------

  private async fetchMemoryContext(request: ExecuteRequest): Promise<string | null> {
    const agentId = request.agentConfig?.agentId as string | undefined
    if (!agentId) return null
    const cfg = (request.agentConfig ?? {}) as Record<string, unknown>
    if (!cfg.memoryEnabled) return null
    try {
      return await buildMemoryContext(agentId, cfg)
    } catch (err) {
      logger.warn({ agentId, taskId: request.taskId, err }, 'Failed to build memory context')
      return null
    }
  }

  // ----------------------------------------------------------
  // Protected: Memory Override 清理（Legacy CLAUDE.md/AGENTS.md 注入）
  // ----------------------------------------------------------

  /**
   * 删除遗留的 memory override 文件（旧版本通过写入 CLAUDE.md/AGENTS.md 注入记忆，
   * 新版本通过 enrichPrompt 直接注入，无需文件写入）。
   * 子类可覆盖以添加额外文件（如 CursorAgent 的 .cursorrules）。
   */
  protected prepareMemoryOverride(request: ExecuteRequest): void {
    const workDir = request.workDir
    if (!workDir) return
    for (const file of ['CLAUDE.md', 'AGENTS.md']) {
      try {
        removeMemoryOverride(join(workDir, file))
      } catch (err) {
        logger.warn({ workDir, file, err }, `Failed to remove legacy memory override from ${file}`)
      }
    }
  }

  // ----------------------------------------------------------
  // Private: Model fallback 循环
  // ----------------------------------------------------------

  private async handleFallback(
    request: StreamExecuteRequest,
    primaryModel: string,
    fallbackModels: string[],
    primaryError: unknown,
    startTime: number,
    memoryContext?: string | null,
  ): Promise<ExecuteResult> {
    const errMsg = primaryError instanceof Error ? primaryError.message : String(primaryError)
    let usage = extractUsageFromError(primaryError)

    if (isModelError(errMsg) && fallbackModels.length > 0) {
      const fallback = selectFallbackModel(primaryModel, fallbackModels)
      if (fallback) {
        logger.info(
          {
            taskId: request.taskId,
            original: primaryModel,
            fallback,
          },
          'Model failed, trying fallback',
        )
        try {
          const fallbackRequest = this.enrichPrompt(
            { ...request, model: fallback, chatId: undefined },
            fallback,
            memoryContext,
          ) as StreamExecuteRequest
          const result = await this.executeStreamWithModel(fallbackRequest, fallback)
          if (result.usage) usage = accumulateUsage(usage, result.usage)
          return {
            ...result,
            durationMs: Date.now() - startTime,
            ...(usage ? { usage } : {}),
          }
        } catch (fallbackErr) {
          const fallbackUsage = extractUsageFromError(fallbackErr)
          if (fallbackUsage) usage = accumulateUsage(usage, fallbackUsage)
          logger.warn({ taskId: request.taskId, fallback }, 'Fallback model also failed')
        }
      }
    }

    return {
      success: false,
      output: '',
      durationMs: Date.now() - startTime,
      error: errMsg,
      ...(usage ? { usage } : {}),
    }
  }
}
