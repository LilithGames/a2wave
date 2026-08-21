/**
 * Command-as-Plugin factory.
 *
 * createCommandPlugin 把声明式 CommandSpec + 行为回调（applySession /
 * runConfigPatch）编译成一个标准 LifecyclePlugin，自动生成 onBeforeRun
 * 钩子：当 ctx.matchedCommand === init.commandName 时执行用户声明的副作用。
 *
 * Dispatcher（core:command-dispatch）独立运行在 onAuthenticated 阶段，
 * 仲裁前缀匹配并写 ctx.matchedCommand；commandDispatch.priority < cmd plugin priority
 * 保证 dispatcher 先跑、cmd plugin 后跑。
 */

import type { RunCtx } from '../types.js'
import type { CommandPlugin, CommandPluginInit } from './types.js'

/** Command plugin 默认优先级。Dispatcher 用 PRIORITY_DISPATCH（更小）保证先跑。 */
const PRIORITY_COMMAND = 20

export function createCommandPlugin(init: CommandPluginInit): CommandPlugin {
  const buildSessionCtx = (ctx: RunCtx) => ({
    commandName: init.commandName,
    agentEngineType: ctx.engineType,
    rawText: ctx.rawText,
    strippedText: ctx.strippedText,
  })

  return {
    // CommandSpec 字段（声明式元数据，dispatcher 读这些做仲裁）
    commandName: init.commandName,
    prefixes: init.prefixes,
    allowedContexts: init.allowedContexts,
    emptyTextFallback: init.emptyTextFallback,
    longRunningAck: init.longRunningAck,
    respond: init.respond,

    // LifecyclePlugin 字段
    name: `cmd:${init.commandName}`,
    priority: PRIORITY_COMMAND,

    async onBeforeRun(ctx: RunCtx) {
      // 只对 dispatcher 已经命中的命令生效；其他 plugin / 普通消息全部跳过
      if (ctx.matchedCommand !== init.commandName) return null

      if (init.applySession) {
        const r = await init.applySession(buildSessionCtx(ctx))
        if (r.override !== undefined) ctx.chatIdOverride = r.override
      }

      if (init.runConfigPatch) {
        const patch = init.runConfigPatch(buildSessionCtx(ctx))
        ctx.runConfigPatch = { ...(ctx.runConfigPatch ?? {}), ...patch }
      }

      // preAck：text/post/interactive 模式下的长操作前置反馈
      if (init.longRunningAck !== undefined) {
        ctx.preAck =
          typeof init.longRunningAck === 'function'
            ? init.longRunningAck(buildSessionCtx(ctx))
            : init.longRunningAck
      }

      return null
    },
  }
}
