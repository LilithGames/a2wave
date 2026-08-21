/**
 * 飞书指令通道类型定义（Command-as-Plugin 模型）。
 *
 * Command 不是独立注册概念，而是一种 LifecyclePlugin 的特化：
 *   CommandPlugin = LifecyclePlugin & CommandSpec
 *
 * 用 `createCommandPlugin` factory 产出 CommandPlugin 实例：
 *   - LifecyclePlugin 部分由 factory 自动生成（主要是 onBeforeRun 钩子）
 *   - CommandSpec 部分由调用方声明
 *
 * Dispatcher（core:command-dispatch）持有 CommandPlugin 列表（闭包），
 * 在 onAuthenticated 里仲裁前缀匹配，写 ctx.matchedCommand + strippedText。
 */

import type { LifecyclePlugin, RunCtx } from '../types.js'

export type Awaitable<T> = T | Promise<T>

/** Context passed to applySession / runConfigPatch / longRunningAck. Pure data; no side effects. */
export interface SessionResolveCtx {
  readonly commandName: string
  readonly agentEngineType: string
  readonly rawText: string
  readonly strippedText: string
}

/** Override semantics: null = clear; undefined = preserve; string = override. */
export interface SessionResolution {
  readonly override: string | null | undefined
}

export interface RunConfigPatchCtx extends SessionResolveCtx {}
export interface AckCtx extends SessionResolveCtx {}

/** Subset of WorkerTaskPayload that commands may patch. */
export interface RunConfigPatch {
  extraEngineFlags?: readonly string[]
  [key: string]: unknown
}

/**
 * 命令的声明式元数据契约。CommandPlugin 必须同时满足这个接口。
 */
export interface CommandSpec {
  /** 命令短名（如 'new'），命中后写入 ctx.matchedCommand */
  readonly commandName: string
  /** 行首触发前缀列表 */
  readonly prefixes: readonly string[]
  /**
   * 限制命令仅在某些上下文里生效；其他上下文等同未命中。
   * dispatcher 不剥前缀、不激活命令，消息按普通文本走 LLM。
   * 未声明时不做限制。
   */
  readonly allowedContexts?: readonly ('p2p' | 'group' | 'thread')[]
  /**
   * 命中前缀但 stripped text 为空时（如裸 `/new`），用作 prompt 注入文本。
   * 让 bare command 与带文本形态走相同 pipeline。
   */
  readonly emptyTextFallback?: string
  /**
   * 长时命令预 ACK 文本。可静态或动态。
   * text/post/interactive 模式下立刻 fire-and-forget 发一条预 ACK；
   * streaming_card 跳过。
   */
  readonly longRunningAck?: string | ((ctx: AckCtx) => string)
  /**
   * 程序化应答：返回文本则由 dispatcher abort，消息不进 LLM、不产生 Run。
   * 返回 null = 放弃应答，按普通文本继续走 LLM。
   *
   * 用于平台自身可直接回答的运维查询（如 `/status`）——它们既没有推理成分，
   * 也不该为一次状态查询占用并发槽。有副作用的命令仍走 applySession /
   * runConfigPatch，让消息照常抵达 Agent。
   */
  readonly respond?: (ctx: CommandRespondCtx) => Awaitable<string | null>
}

/** Passed to `respond`; carries the matched Agent so the responder can read its own state. */
export interface CommandRespondCtx extends SessionResolveCtx {
  readonly agent: { id: string; userId: string | null; [k: string]: unknown }
}

/**
 * CommandPlugin = LifecyclePlugin & CommandSpec。
 *
 * 通过 createCommandPlugin factory 产生。dispatcher 用 isCommandPlugin
 * 在 pipeline 的 plugin 列表里把它们筛出来做前缀仲裁。
 */
export interface CommandPlugin extends LifecyclePlugin, CommandSpec {}

/**
 * Runtime type guard：判断一个 LifecyclePlugin 是否同时是 CommandPlugin。
 * Dispatcher 用它过滤候选。
 */
export function isCommandPlugin(p: LifecyclePlugin): p is CommandPlugin {
  return (
    typeof (p as CommandPlugin).commandName === 'string' &&
    Array.isArray((p as CommandPlugin).prefixes)
  )
}

/**
 * createCommandPlugin 的输入：CommandSpec 字段 + 命中后的行为钩子。
 */
export interface CommandPluginInit extends CommandSpec {
  /**
   * 会话覆盖策略；省略 = preserve（chatIdOverride undefined）。
   * - override: null    → 清空 previousChatId（开新会话）
   * - override: string  → 用指定 chatId 覆盖
   * - override: undefined → 不干预
   */
  applySession?: (ctx: SessionResolveCtx) => Awaitable<SessionResolution>
  /** 命中后对 runConfig 的补丁；与已有 runConfigPatch 浅合并 */
  runConfigPatch?: (ctx: RunConfigPatchCtx) => RunConfigPatch
}

// Re-export RunCtx for plugins that need to type their hooks (e.g. tests)
export type { RunCtx }
